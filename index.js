/**
 * Rolling S3 streams class
 */

'use strict'

/**
 * Dependencies
 */

const EventEmitter = require('events').EventEmitter
const schedule = require('node-schedule').scheduleJob
const moment = require('moment')
const mkdirp = require('mkdirp')
const spawn = require('child_process').spawn
const fs = require('fs')

/**
 * Defines a stream class that appends locally and periodically syncs to S3
 */

class RotatingS3Stream extends EventEmitter {

  /**
   * @constructor
   *
   * @param {Object} opts The options object that specifies prefixes, filesize,
   * and rotation schedule
   * @param {String} opts.localPrefix The local path to store logs before they
   * are synced
   * @param {String} opts.s3Prefix The s3 prefix to sync to
   * @param {Integer} opts.maxFileSize The max file size to keep locally before
   * syncing (in bytes)
   * @param {Integer} opts.maxFileAge The max file age to keep before syncing
   * (in seconds)
   * @param {Function} [opts.createFileName] Optional. A function to
   * dynamically create log file names. Defaults to moment.js's format function
   */

  constructor(opts) {
    super()

    // Validate stream options
    if (typeof opts.localPrefix !== 'string') {
      throw new Error('localPrefix must be a string')
    }
    if (typeof opts.maxFileSize !== 'number' || !(opts.maxFileSize > 0)) {
      throw new Error('maxFileSize must be a number greater than 0')
    }
    if (typeof opts.maxFileAge !== 'number' || !(opts.maxFileAge > 0)) {
      throw new Error('maxFileAge must be a number greater than 0')
    }
    if (typeof opts.s3Prefix !== 'string' || opts.s3Prefix.indexOf('s3://') === -1) {
      throw new Error('s3Prefix must be a valid s3 prefix in the form: s3://<bucket><prefix>')
    }
    if (typeof opts.createFileName !== 'undefined'
      && typeof opts.createFileName !== 'function') {
      throw new Error('createFileName must be a function')
    }

    // Default name format is to use moment's "format"
    if (!opts.createFileName) {
      this.createFileName = () => moment().format()
    } else {
      this.createFileName = opts.createFileName
    }

    this.localPrefix = opts.localPrefix
    this.maxFileSize = opts.maxFileSize
    this.maxFileAge = opts.maxFileAge
    this.s3Prefix = opts.s3Prefix

    mkdirp.sync(this.localPrefix)
    this.createStream()

    // Check every minute if file should be rotated. If the stream is old
    // enough or the file size is large enough, ootate and sync to S3
    schedule('* * * * *', () => this.checkAndRotate())
  }

  /**
   * Creates a new write stream
   */

  createStream() {
    const fileName = this.createFileName()
    this.source = `${this.localPrefix}/${fileName}`
    this.destination = `${this.s3Prefix}/${fileName}`
    this.created = new Date().getTime()
    if (this.stream) {
      this.stream.end()
    }
    this.stream = fs.createWriteStream(this.source, {
      flags: 'a'
    })

    // Use setImmediate to allow listeners to recieve this message initially
    // If setImmediate is not used, the first message is not recieved, since
    // this all happens synchronously on instantiation
    setImmediate(() => {
      this.emit('info', {
        message: 'Created new write stream',
        source: this.source,
        destination: this.destination
      })
    })
  }

  /**
   * Check if the stream is old enough or if the file is large enough to rotate.
   * If so, initiate rotation.
   */

  checkAndRotate() {
    fs.stat(this.source, (error, status) => {
      if (error) {
        this.emit('error', {
          message: 'fs.stat failed',
          source: this.source,
          error
        })
        return
      }

      const ageInSeconds = Math.floor((Date.now() - this.created) / 1000)

      // Save file size to avoid syncing if it is empty
      this.empty = status.size === 0

      // Check if file has reached max age
      if (ageInSeconds > this.maxFileAge) {
        this.rotate('Max file age reached')

        // Check if file has reached max size
      } else if (status.size > this.maxFileSize) {
        this.rotate('Max file size reached')
      }
    })
  }

  /**
   * Rotate write stream file, sync old one to S3 then delete
   *
   * @param {String} reason Reason for rotating file (max age, max size, force)
   */

  rotate(reason) {
    this.emit('info', {
      message: 'Rotating stream',
      source: this.source,
      destination: this.destination,
      reason
    })

    // Save current source and destination, then create new write steram
    const source = this.source
    const destination = this.destination
    this.createStream()

    // If the file isn't empty, sync to S3
    if (!this.empty) {
      const awscp = spawn('aws', ['s3', 'cp', source, destination])

      awscp.stdout.on('data', data => this.emit('info', {
        message: data.toString().trim()
      }))

      awscp.stderr.on('data', data => this.emit('error', {
        message: data.toString().trim()
      }))

      awscp.on('close', (code) => {
        if (code !== 0) {
          this.emit('error', {
            message: 'AWS S3 cp failed',
            code,
            source,
            destination
          })
        } else {
          this.emit('info', {
            message: 'Rotated and synced stream to s3',
            source,
            destination
          })
          fs.unlink(source)
        }
      })
    } else {
      this.emit('info', {
        message: 'Rotating empty local stream without S3 sync',
        source
      })
      fs.unlink(source)
    }
  }

  /**
   * Write to the stream
   *
   * @param {String} data The information to write
   */

  write(data) {
    this.stream.write(data)
  }

  /**
   * Manually rotate stream regardless of age or file size.
   */

  flush() {
    this.rotate({
      reason: 'External flush request'
    })
  }
}

/**
 * Exports
 */

module.exports = RotatingS3Stream
