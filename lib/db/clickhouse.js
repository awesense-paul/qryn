/*
 * Qryn DB Adapter for Clickhouse
 * (C) 2018-2022 QXIP BV
 */

const UTILS = require('../utils')
const toJSON = UTILS.toJSON
const logger = require('../logger')
const { formatISO9075 } = require('date-fns')
const { Blob } = require('buffer')
const Zipkin = require('./zipkin')
const Otlp = require('./otlp')
const logfmt = require('logfmt')
const csql = require('@cloki/clickhouse-sql')
const clusterName = require('../../common').clusterName
const dist = clusterName ? '_dist' : ''

/* DB Helper */
const ClickHouse = require('@apla/clickhouse')

const transpiler = require('../../parser/transpiler')
const rotationLabels = process.env.LABELS_DAYS || 7
const rotationSamples = process.env.SAMPLES_DAYS || 7
const axios = require('axios')
const { samplesTableName, samplesReadTableName } = UTILS
const path = require('path')
const { Transform } = require('stream')
const { CORS, bun, readonly, boolEnv } = require('../../common')
const clickhouseOptions = require('./clickhouse_options').databaseOptions
const { getClickhouseUrl } = require('./clickhouse_options')

// External Storage Policy for Tables (S3, MINIO)
const storagePolicy = process.env.STORAGE_POLICY || false
// Clickhouse Distributed Engine setting to skip unavailable shards
const skipUnavailableShards = process.env.SKIP_UNAVAILABLE_SHARDS || false

const { StringStream, DataStream } = require('scramjet')

const { parseLabels, hashLabels, isCustomSamplesOrderingRule, isOmitTablesCreation } = require('../../common')

const { Worker, isMainThread } = require('worker_threads')

const jsonSerializer = (k, val) => typeof val === 'bigint'
  ? val.toString()
  : typeof val === 'number' && isNaN(val)
    ? 'NaN'
    : val

const createCsvArrayWriter = require('csv-writer').createArrayCsvStringifier

const capabilities = {}
let state = 'INITIALIZING'

const clickhouse = new ClickHouse(clickhouseOptions)
let ch

const conveyor = {
  labels: 0,
  lastUpdate: 0,
  count: async () => {
    if (conveyor.lastUpdate < Date.now() - 30000) {
      return conveyor.labels
    }
    try {
      const resp = await rawRequest(`SELECT COUNT(1) as c FROM ${UTILS.DATABASE_NAME()}.time_series FORMAT JSON`)
      conveyor.labels = resp.data.data[0].c
      return conveyor.labels
    } catch (e) {
      logger.error(e)
    }
  }
}

let throttler = null
const resolvers = {}
const rejectors = {}
let first = false
if (isMainThread && !bun()) {
  throttler = new Worker(path.join(__dirname, 'throttler.js'))
  throttler.on('message', (msg) => {
    switch (msg.status) {
      case 'ok':
        resolvers[msg.id]()
        break
      case 'err':
        rejectors[msg.id](new Error('Database push error'))
        break
    }
    delete resolvers[msg.id]
    delete rejectors[msg.id]
  })
} else if (isMainThread && !first) {
  first = true
  setTimeout(() => {
    const _throttler = require('./throttler')
    throttler = {
      on: _throttler.on,
      postMessage: _throttler.postMessage,
      removeAllListeners: _throttler.removeAllListeners,
      terminate: _throttler.terminate
    }
    _throttler.init()
    throttler.on('message', (msg) => {
      switch (msg.status) {
        case 'ok':
          resolvers[msg.id]()
          break
        case 'err':
          rejectors[msg.id](new Error('Database push error'))
          break
      }
      delete resolvers[msg.id]
      delete rejectors[msg.id]
    })
  })
}
// timeSeriesv2Throttler.start();

/* Cache Helper */
const recordCache = require('record-cache')
const { parseMs, DATABASE_NAME } = require('../utils')
let id = 0
function getThrottlerId () {
  id = (id + 1) % 1e6
  return id
}
// Flushing to Clickhouse
const bulk = {
  add: (values) => {
    const id = getThrottlerId()
    return new Promise((resolve, reject) => {
      throttler.postMessage({
        type: 'values',
        data: values.map(r => JSON.stringify({
          fingerprint: r[0],
          timestamp_ns: r[1],
          value: r[2],
          string: r[3],
          type: r[4]
        }, jsonSerializer)).join('\n'),
        id: id
      })
      resolvers[id] = resolve
      rejectors[id] = reject
    })
  }
}

const bulkLabels = {
  add: (values) => {
    return new Promise((resolve, reject) => {
      const id = getThrottlerId()
      throttler.postMessage({
        type: 'labels',
        data: values.map(r => JSON.stringify({
          date: r[0],
          fingerprint: r[1],
          labels: r[2],
          name: r[3],
          type: r[4]
        }, jsonSerializer)).join('\n'),
        id: id
      })
      resolvers[id] = resolve
      rejectors[id] = reject
    })
  }
}

// In-Memory LRU for quick lookups
const labels = recordCache({
  maxSize: process.env.BULK_MAXCACHE || 50000,
  maxAge: 0,
  onStale: false
})

const checkDB = async function() {
  await checkCapabilities()
  await samplesReadTable.check()
}

/* Initialize */
const initialize = async function (dbName) {
  logger.info('Initializing DB... ' + dbName)
  const tmp = { ...clickhouseOptions, queryOptions: { database: '' } }
  ch = new ClickHouse(tmp)
  if (readonly) {
    state = 'READY'
    return
  }
  if (!isOmitTablesCreation()) {
    const maintain = require('./maintain/index')
    await maintain.upgrade({ name: dbName, storage_policy: storagePolicy, skip_unavailable_shards: skipUnavailableShards })
    await maintain.rotate([{
      db: dbName,
      samples_days: rotationSamples,
      time_series_days: rotationLabels,
      storage_policy: storagePolicy
    }])
  } else {
    logger.info('Omitting tables creation')
  }

  state = 'READY'

  reloadFingerprints()
}

const checkCapabilities = async () => {
  logger.info('Checking clickhouse capabilities')
  // qryn doesn't use LIVE VIEW after ClickHouse dropped WITH TIMEOUT clause support
  capabilities.liveView = false
}

const reloadFingerprints = function () {
  return;
  logger.info('Reloading Fingerprints...')
  const selectQuery = `SELECT DISTINCT fingerprint, labels FROM ${clickhouseOptions.queryOptions.database}.time_series`
  const stream = ch.query(selectQuery)
  // or collect records yourself
  const rows = []
  stream.on('metadata', function (columns) {
    // do something with column list
  })
  stream.on('data', function (row) {
    rows.push(row)
  })
  stream.on('error', function (err) {
    logger.error(err, 'Error reloading fingerprints')
  })
  stream.on('end', function () {
    rows.forEach(function (row) {
      try {
        const JSONLabels = toJSON(row[1]/*.replace(/\!?=/g, ':')*/)
        labels.add(row[0], JSON.stringify(JSONLabels))
        for (const key in JSONLabels) {
          // logger.debug('Adding key',row);
          labels.add('_LABELS_', key)
          labels.add(key, JSONLabels[key])
        }
      } catch (err) { logger.error(err, 'error reloading fingerprints') }
    })
  })
}

const fakeStats = { summary: { bytesProcessedPerSecond: 0, linesProcessedPerSecond: 0, totalBytesProcessed: 0, totalLinesProcessed: 0, execTime: 0.001301608 }, store: { totalChunksRef: 0, totalChunksDownloaded: 0, chunksDownloadTime: 0, headChunkBytes: 0, headChunkLines: 0, decompressedBytes: 0, decompressedLines: 0, compressedBytes: 0, totalDuplicates: 0 }, ingester: { totalReached: 1, totalChunksMatched: 0, totalBatches: 0, totalLinesSent: 0, headChunkBytes: 0, headChunkLines: 0, decompressedBytes: 0, decompressedLines: 0, compressedBytes: 0, totalDuplicates: 0 } }

const scanFingerprints = async function (query) {
  logger.debug('Scanning Fingerprints...')
  const _query = transpiler.transpile(query)
  _query.step = UTILS.parseDurationSecOrDefault(query.step, 5) * 1000
  _query.csv = query.csv
  return queryFingerprintsScan(_query)
}

const scanTempo = async function (query) {
  return queryTempoScan(query)
}

const instantQueryScan = async function (query) {
  logger.debug('Scanning Fingerprints...')
  const time = parseMs(query.time, Date.now())
  query.start = (time - 10 * 60 * 1000) * 1000000
  query.end = Date.now() * 1000000
  const _query = transpiler.transpile(query)
  _query.step = UTILS.parseDurationSecOrDefault(query.step, 5) * 1000

  const _stream = await axios.post(getClickhouseUrl() + '/',
    _query.query + ' FORMAT JSONEachRow',
    {
      responseType: 'stream'
    }
  )
  const dataStream = preprocessStream(_stream, _query.stream || [])
  const res = new Transform({
    transform (chunk, encoding, callback) {
      callback(null, chunk)
    }
  })
  setTimeout(() => {
    try {
      _query.matrix ? outputQueryVector(dataStream, res) : outputQueryStreams(dataStream, res)
    } catch (e) { logger.error(e) }
  }, 0)
  return res
}

const tempoQueryScan = async function (query, res, traceId) {
  const response = {
    v2: [],
    v1: []
  }
  response.v2 = await tempoQueryScanV2(query, res, traceId)
  return response
}

const tempoQueryScanV2 = async function (query, res, traceId) {
  logger.debug(`Scanning Tempo Fingerprints... ${traceId}`)
  const _stream = await axios.post(getClickhouseUrl() + '/',
    `SELECT payload_type, payload FROM ${DATABASE_NAME()}.tempo_traces${dist} WHERE oid='0' AND trace_id=unhex('${traceId}') ORDER BY timestamp_ns ASC LIMIT 2000 FORMAT JSONEachRow`,
    {
      responseType: 'stream'
    }
  )
  return await StringStream.from(_stream.data).lines().map((e) => {
    try {
      const _e = JSON.parse(e)
      return { ..._e, payload: JSON.parse(_e.payload) }
    } catch (e) {
      return null
    }
  }, DataStream).filter(e => e).toArray()
}

const tempoSearchScan = async function (query, res) {
  logger.debug(`Scanning Tempo traces... ${query.tags}`)
  const time = parseMs(query.time, Date.now())
  /* Tempo does not seem to pass start/stop parameters. Use ENV or default 24h */
  const hours = this.tempo_span || 24
  if (!query.start) query.start = (time - (hours * 60 * 60 * 1000)) * 1000000
  if (!query.end) query.end = Date.now() * 1000000
  const _query = transpiler.transpile(query)
  _query.step = UTILS.parseDurationSecOrDefault(query.step, 5) * 1000

  const _stream = await axios.post(getClickhouseUrl() + '/',
    _query.query + ' FORMAT JSONEachRow',
    {
      responseType: 'stream'
    }
  )
  const dataStream = preprocessStream(_stream, _query.stream || [])
  logger.info('debug tempo search', query)
  return await (outputTempoSearch(dataStream, res))
}

/**
 *
 * @param traces {Object[]} openzipkin traces array see https://zipkin.io/zipkin-api/#/default/post_spans
 * @returns {Promise<unknown>}
 */
function pushZipkin (traces) {
  return new Promise((resolve, reject) => {
    const id = getThrottlerId()
    throttler.postMessage({
      type: 'traces',
      data: traces.map(obj => (new Zipkin(obj)).toJson()).join('\n'),
      id: id
    })
    resolvers[id] = resolve
    rejectors[id] = reject
  })
}

/**
 *
 * @param traces {Object[]} openzipkin traces array see https://zipkin.io/zipkin-api/#/default/post_spans
 * @returns {Promise<unknown>}
 */
function pushOTLP (traces) {
  return new Promise((resolve, reject) => {
    const id = getThrottlerId()
    throttler.postMessage({
      type: 'traces',
      data: traces.map(obj => (new Otlp(obj)).toJson()).join('\n'),
      id: id
    })
    resolvers[id] = resolve
    rejectors[id] = reject
  })
}

/**
 * @param query {{
 *   query: string,
 *   duration: number,
 *   matrix: boolean,
 *   stream: (function(DataStream): DataStream)[],
 *   step: number,
 *   csv?: boolean
 * }}
 * @returns {Promise<Readable>}
 */
const queryFingerprintsScan = async function (query) {
  logger.debug('Scanning Fingerprints...')

  // logger.info(_query.query);
  const _stream = await getClickhouseStream(query)
  const dataStream = preprocessStream(_stream, query.stream || [])
  const res = new Transform({
    transform (chunk, encoding, callback) {
      callback(null, chunk)
    }
  })
  if (query.csv) {
    setTimeout(async () => {
      try {
        await (query.matrix
          ? outputQueryMatrixCSV(dataStream, res, query.step, query.duration)
          : outputQueryStreamsCSV(dataStream, res))
      } catch (e) { logger.error(e) }
    }, 0)
    return res
  }
  setTimeout(async () => {
    try {
      await (query.matrix
        ? outputQueryMatrix(dataStream, res, query.step, query.duration)
        : outputQueryStreams(dataStream, res))
    } catch (e) { logger.error(e) }
  }, 0)
  return res
}

/**
 * @param query {{
 *   query: string,
 *   duration: number,
 *   matrix: boolean,
 *   stream: (function(DataStream): DataStream)[],
 *   step: number,
 *   start: number,
 *   end: number,
 *   minDurationNs: number,
 *   maxDurationNs: number,
 *   tags: Object<string, string>
 * }}
 * @returns {Promise<{v1: Object[], v2: Object[]}>}
 */
const queryTempoScan = async function (query) {
  const resp = {
    v1: [],
    v2: []
  }
  resp.v2 = await queryTempoScanV2({ ...query })
  return resp
}

const queryTempoScanV2 = async function (query) {
  const select = `SELECT hex(trace_id) as traceID, service_name as rootServiceName,
    name as rootTraceName, timestamp_ns as startTimeUnixNano,
    intDiv(duration_ns, 1000000) as durationMs`
  const from = `FROM ${DATABASE_NAME()}.tempo_traces${dist}`
  const where = [
    'oid = \'0\'',
    `timestamp_ns >= ${parseInt(query.start)} AND timestamp_ns <= ${parseInt(query.end)}`,
    (query.minDurationNs ? `duration_ns >= ${parseInt(query.minDurationNs)}` : null),
    (query.maxDurationNs ? `duration_ns <= ${parseInt(query.maxDurationNs)}` : null)
  ].filter(e => e)
  let idxSubsel = null
  if (query.tags) {
    idxSubsel = Object.entries(query.tags)
      .map(e => {
        const timestampNs = query.limit ? ', timestamp_ns' : ''
        let subQ = `SELECT trace_id, span_id ${timestampNs} FROM ${DATABASE_NAME()}.tempo_traces_attrs_gin WHERE oid='0'` +
          ` AND date >= '${formatISO9075(query.start / 1000000).substring(0, 10)}' ` +
          ` AND date <= '${formatISO9075(query.end / 1000000).substring(0, 10)}'` +
          ` AND key = ${csql.quoteVal(e[0].toString())} AND val = ${csql.quoteVal(e[1].toString())}` +
          ` AND timestamp_ns >= ${parseInt(query.start)} AND timestamp_ns <= ${parseInt(query.end)}`
        if (query.minDurationNs) {
          subQ += ` AND duration >= ${query.minDurationNs}`
        }
        if (query.maxDurationNs) {
          subQ += ` AND duration <= ${query.maxDurationNs}`
        }
        return subQ
      }).join(' INTERSECT ')
    if (query.limit) {
      idxSubsel = `SELECT trace_id, span_id FROM (${idxSubsel}) as rawsubsel ` +
        `ORDER BY timestamp_ns DESC LIMIT ${parseInt(query.limit)}`
    }
    where.push(`(trace_id, span_id) IN (${idxSubsel})`)
  }
  const limit = query.limit ? `LIMIT ${parseInt(query.limit)}` : ''
  const sql = `${select} ${from} WHERE ${where.join(' AND ')} ORDER BY timestamp_ns DESC ${limit} FORMAT JSON`
  const resp = await rawRequest(sql, null, process.env.CLICKHOUSE_DB || 'cloki')
  return resp.data.data ? resp.data.data : JSON.parse(resp.data).data
}

async function queryTempoTags () {
  const q = `SELECT distinct key
    FROM ${DATABASE_NAME()}.tempo_traces_kv${dist}
    WHERE oid='0' AND date >= toDate(NOW()) - interval '1 day'
    FORMAT JSON`
  const resp = await axios.post(getClickhouseUrl() + '/',q)
  return resp.data.data ? resp.data.data : JSON.parse(resp.data).data
}

/**
 *
 * @param tag {string}
 * @returns {Promise<{val: string}[]>}
 */
async function queryTempoValues (tag) {
  const q = `SELECT distinct val
    FROM ${DATABASE_NAME()}.tempo_traces_kv${dist}
    WHERE oid='0' AND date >= toDate(NOW()) - interval '1 day' AND key = ${csql.quoteVal(tag)}
    FORMAT JSON`
  const resp = await axios.post(getClickhouseUrl() + '/', q)
  return resp.data.data ? resp.data.data : JSON.parse(resp.data).data
}

/**
 *
 * @param query {{query: string}}
 * @returns {Promise<Stream>}
 */
const getClickhouseStream = (query) => {
  return axios.post(getClickhouseUrl() + '/',
    query.query + ' FORMAT JSONEachRow',
    {
      responseType: 'stream'
    }
  )
}

/**
 *
 * @param dataStream {DataStream}
 * @param res {{res: {
 *  write: (function(string)),
 *  onBegin: (function(string)),
 *  onEnd: (function(string))
 * }}}
 * @param i {number}
 * @returns {Promise<void>}
 */
const outputQueryStreams = async (dataStream, res, i) => {
  //res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': CORS })
  const gen = dataStream.toGenerator()
  i = i || 0
  let lastLabels = null
  let lastStream = []
  res.onBegin
    ? res.onBegin('{"status":"success", "data":{ "resultType": "streams", "result": [')
    : res.write('{"status":"success", "data":{ "resultType": "streams", "result": [')
  for await (const item of gen()) {
    if (!item) {
      continue
    }
    if (!item.labels) {
      if (!lastLabels || !lastStream.length) {
        continue
      }
      res.write(i ? ',' : '')
      res.write(JSON.stringify({
        stream: parseLabels(lastLabels),
        values: lastStream
      }))
      lastLabels = null
      lastStream = []
      ++i
      continue
    }
    const hash = hashLabels(item.labels)
    const ts = item.timestamp_ns || null
    if (hash === lastLabels) {
      ts && lastStream.push([ts, item.string])
      continue
    }
    if (lastLabels) {
      res.write(i ? ',' : '')
      res.write(JSON.stringify({
        stream: parseLabels(lastLabels),
        values: lastStream
      }))
      ++i
    }
    lastLabels = hash
    lastStream = ts ? [[ts, item.string]] : []
  }
  res.onEnd ? res.onEnd(']}}') : res.write(']}}')
  res.end()
}

/**
 *
 * @param dataStream {DataStream}
 * @param res {{res: {
 *  write: (function(string)),
 *  onBegin: (function(string)),
 *  onEnd: (function(string))
 * }}}
 * @param i {number}
 * @returns {Promise<void>}
 */
const outputQueryStreamsCSV = async (dataStream, res, i) => {
  //res.writeHead(200, { 'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': CORS })
  const gen = dataStream.toGenerator()
  const writer = createCsvArrayWriter({
    header: ['timestamp_ns', 'labels', 'string']
  })
  res.onBegin
    ? res.onBegin(writer.getHeaderString())
    : res.write(writer.getHeaderString())
  for await (const item of gen()) {
    if (!item) {
      continue
    }
    const record = [
      item.timestamp_ns,
      JSON.stringify(item.labels),
      item.string
    ]
    res.write(writer.stringifyRecords([record]))
  }
  res.onEnd ? res.onEnd('') : res.write('')
  res.end()
}

/**
 *
 * @param dataStream {DataStream}
 * @param res {{write: (function(string))}}
 * @param stepMs {number}
 * @param durationMs {number}
 * @returns {Promise<void>}
 */
const outputQueryMatrix = async (dataStream, res,
  stepMs, durationMs) => {
  //res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': CORS })
  const addPoints = Math.ceil(durationMs / stepMs)
  const gen = dataStream.toGenerator()
  let i = 0
  let lastLabels = null
  let lastStream = []
  let lastTsMs = 0
  res.write('{"status":"success", "data":{ "resultType": "matrix", "result": [')
  for await (const item of gen()) {
    if (!item) {
      continue
    }
    if (!item.labels) {
      if (!lastLabels || !lastStream.length) {
        continue
      }
      res.write(i ? ',' : '')
      res.write(JSON.stringify({
        metric: parseLabels(lastLabels),
        values: lastStream
      }))
      lastLabels = null
      lastStream = []
      lastTsMs = 0
      ++i
      continue
    }
    const hash = hashLabels(item.labels)
    const ts = item.timestamp_ns ? parseInt(item.timestamp_ns) : null
    if (hash === lastLabels) {
      if (ts < (lastTsMs + stepMs)) {
        continue
      }
      for (let j = 0; j < addPoints; ++j) {
        ts && lastStream.push([(ts + stepMs * j) / 1000, item.value.toString()])
      }
      lastTsMs = ts
      continue
    }
    if (lastLabels) {
      res.write(i ? ',' : '')
      res.write(JSON.stringify({
        metric: parseLabels(lastLabels),
        values: lastStream
      }))
      ++i
    }
    lastLabels = hash
    lastStream = []
    for (let j = 0; j < addPoints; ++j) {
      ts && lastStream.push([(ts + stepMs * j) / 1000, item.value.toString()])
    }
    lastTsMs = ts
  }
  res.write(']}}')
  res.end()
}

/**
 *
 * @param dataStream {DataStream}
 * @param res {{write: (function(string))}}
 * @param stepMs {number}
 * @param durationMs {number}
 * @returns {Promise<void>}
 */
const outputQueryMatrixCSV = async (dataStream, res,
  stepMs, durationMs) => {
  //res.writeHead(200, { 'Content-Type': 'text/csv', 'Access-Control-Allow-Origin': CORS })
  const addPoints = Math.ceil(durationMs / stepMs)
  const gen = dataStream.toGenerator()
  let lastTsMs = 0
  let hash = ''

  const writer = createCsvArrayWriter({
    header: ['timestamp_ns', 'labels', 'value']
  })
  res.onBegin
    ? res.onBegin(writer.getHeaderString())
    : res.write(writer.getHeaderString())
  for await (const item of gen()) {
    if (!item || !item.labels) {
      continue
    }
    if (hashLabels(item.labels) !== hash) {
      hash = hashLabels(item.labels)
      lastTsMs = 0
    }
    const ts = item.timestamp_ns ? parseInt(item.timestamp_ns) : null
    if (ts < (lastTsMs + stepMs)) {
      continue
    }
    for (let j = 0; j < addPoints; ++j) {
      const record = [
        (ts + stepMs * j) * 1000000,
        JSON.stringify(item.labels),
        item.value.toString()
      ]
      ts && res.write(writer.stringifyRecords([record]))
      lastTsMs = (ts + stepMs * j)
    }
  }
  res.onEnd ? res.onEnd('') : res.write('')
  res.end()
}

/**
 *
 * @param dataStream {DataStream}
 * @param res {Writable}
 * @returns {Promise<void>}
 */
const outputQueryVector = async (dataStream, res) => {
  //res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': CORS })
  const gen = dataStream.toGenerator()
  let i = 0
  let lastLabels = null
  let lastTsMs = 0
  let lastValue = 0
  res.write('{"status":"success", "data":{ "resultType": "vector", "result": [')
  for await (const item of gen()) {
    if (!item) {
      continue
    }
    if (!item.labels) {
      if (!lastLabels || !lastTsMs) {
        continue
      }
      res.write(i ? ',' : '')
      res.write(JSON.stringify({
        metric: parseLabels(lastLabels),
        value: [lastTsMs / 1000, lastValue.toString()]
      }))
      lastLabels = null
      lastTsMs = 0
      ++i
      continue
    }
    const hash = hashLabels(item.labels)
    const ts = item.timestamp_ns ? parseInt(item.timestamp_ns) : null
    if (hash === lastLabels) {
      lastTsMs = ts
      lastValue = item.value
      continue
    }
    if (lastLabels) {
      res.write(i ? ',' : '')
      res.write(JSON.stringify({
        metric: parseLabels(lastLabels),
        value: [lastTsMs / 1000, lastValue.toString()]
      }))
      ++i
    }
    lastLabels = hash
    lastTsMs = ts
    lastValue = item.value
  }
  res.write(']}}')
  res.end()
}

/**
 *
 * @param dataStream {DataStream}
 * @param res {{res: {write: (function(string)), writeHead: (function(number, {}))}}}
 * @param traceId {String}
 * @returns {Promise<any>}
 */
const outputTempoSpans = async (dataStream, res, traceId) => {
  // res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': CORS })
  return dataStream.filter(e => e && e.string).map(e => {
    try {
      return JSON.parse(e.string)
    } catch (e) {
      return null
    }
  }, DataStream).filter(e => e).toArray()
}

/**
 *
 * @param dataStream {DataStream}
 * @param res {{res: {write: (function(string)), writeHead: (function(number, {}))}}}
 * @returns {Promise<any>}
 *
 * {"traces": [{"traceID":"AC62F5E32AFE5C28D4F8DCA4C159627E","rootServiceName":"dummy-server","rootTraceName":"request_response","startTimeUnixNano":1661290946168377000,"durationMs":10}]}
 *
 */
const outputTempoSearch = async (dataStream, res) => {
  const gen = dataStream.toGenerator()
  let i = 0
  let response = '{"traces": ['
  for await (const item of gen()) {
    if (!item || !item.string) {
      continue
    }
    let duration = parseInt((item.Span.end_time_unix_nano - item.Span.start_time_unix_nano) / 1000000) || 0;
    let trace = `{"traceID": ${item.Span.trace_id}, "rootServiceName": ${item.ServiceName}, "rootTraceName": ${item.Span.name}, "startTimeUnixNano": ${item.Span.start_time_unix_nano}, "durationMs": ${duration}}`
    response += (i ? ',' : '')
    response += trace
    i++
  }
  response += (']}')
  return response
}


/**
 *
 * @param rawStream {any} Stream from axios response
 * @param processors {(function(DataStream): DataStream)[] | undefined}
 * @returns {DataStream}
 */
const preprocessStream = (rawStream, processors) => {
  let dStream = StringStream.from(rawStream.data).lines().endWith(JSON.stringify({ EOF: true }))
    .map(chunk => {
      try {
        return chunk ? JSON.parse(chunk) : ({})
      } catch (e) {
        return {}
      }
    }, DataStream)
    .map(chunk => {
      try {
        if (!chunk || !chunk.labels) {
          return chunk
        }
        const labels = chunk.extra_labels
          ? { ...parseLabels(chunk.labels), ...parseLabels(chunk.extra_labels) }
          : parseLabels(chunk.labels)
        return { ...chunk, labels: labels }
      } catch (e) {
        logger.info(chunk)
        return chunk
      }
    }, DataStream)
  if (processors && processors.length) {
    processors.forEach(f => {
      dStream = f(dStream)
    })
  }
  return dStream
}

/**
 *
 * @param rawStream {any} Stream from axios response
 * @param processors {(function(DataStream): DataStream)[] | undefined}
 * @returns {DataStream}
 */
const preprocessLiveStream = (rawStream, processors) => {
  let dStream = StringStream.from(rawStream.data).lines().endWith(JSON.stringify({ EOF: true }))
    .map(chunk => chunk ? JSON.parse(chunk) : ({}), DataStream)
    .filter(chunk => {
      return chunk && (chunk.row || chunk.EOF)
    }).map(chunk => ({
      ...(chunk.row || {}),
      EOF: chunk.EOF
    }))
    .map(chunk => {
      try {
        if (!chunk || !chunk.labels) {
          return chunk
        }
        const labels = chunk.extra_labels
          ? { ...parseLabels(chunk.labels), ...parseLabels(chunk.extra_labels) }
          : parseLabels(chunk.labels)
        return { ...chunk, labels: labels }
      } catch (e) {
        logger.info(chunk)
        return chunk
      }
    }, DataStream)
  if (processors && processors.length) {
    processors.forEach(f => {
      dStream = f(dStream)
    })
  }
  return dStream
}

/* Qryn Metrics Column */
const scanMetricFingerprints = function (settings, client, params) {
  logger.debug({ settings }, 'Scanning Clickhouse...')
  // populate matrix structure
  const resp = {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: []
    }
  }
  // Check for required fields or return nothing!
  if (!settings || !settings.table || !settings.db || !settings.tag || !settings.metric) { client.send(resp); return }
  settings.interval = settings.interval ? parseInt(settings.interval) : 60
  if (!settings.timefield) settings.timefield = process.env.CLICKHOUSE_TIMEFIELD || 'record_datetime'

  const tags = settings.tag.split(',')
  let template = 'SELECT ' + tags.join(', ') + ', groupArray((toUnixTimestamp(timestamp_ns)*1000, toString(value))) AS groupArr FROM (SELECT '
  if (tags) {
    tags.forEach(function (tag) {
      tag = tag.trim()
      template += " visitParamExtractString(labels, '" + tag + "') as " + tag + ','
    })
  }
  // if(settings.interval > 0){
  template += ' toStartOfInterval(toDateTime(timestamp_ns/1000), INTERVAL ' + settings.interval + ' second) as timestamp_ns, value' +
  // } else {
  //  template += " timestampMs, value"
  // }

  // template += " timestampMs, value"
  ' FROM ' + settings.db + '.samples RIGHT JOIN ' + settings.db + '.time_series ON samples.fingerprint = time_series.fingerprint'
  if (params.start && params.end) {
    template += ' WHERE ' + settings.timefield + ' BETWEEN ' + parseInt(params.start / 1000000000) + ' AND ' + parseInt(params.end / 1000000000)
    // template += " WHERE "+settings.timefield+" BETWEEN "+parseInt(params.start/1000000) +" AND "+parseInt(params.end/1000000)
  }
  if (tags) {
    tags.forEach(function (tag) {
      tag = tag.trim()
      template += " AND (visitParamExtractString(labels, '" + tag + "') != '')"
    })
  }
  if (settings.where) {
    template += ' AND ' + settings.where
  }
  template += ' AND value > 0 ORDER BY timestamp_ns) GROUP BY ' + tags.join(', ')

  const stream = ch.query(template)
  // or collect records yourself
  const rows = []
  stream.on('metadata', function (columns) {
    // do something with column list
  })
  stream.on('data', function (row) {
    rows.push(row)
  })
  stream.on('error', function (err) {
    // TODO: handler error
    client.code(400).send(err)
  })
  stream.on('end', function () {
    logger.debug({ rows }, 'CLICKHOUSE RESPONSE')
    if (!rows || rows.length < 1) {
      resp.data.result = []
      resp.data.stats = fakeStats
    } else {
      try {
        rows.forEach(function (row) {
          const metrics = { metric: {}, values: [] }
          const tags = settings.tag.split(',')
          // bypass empty blocks
          if (row[row.length - 1].length < 1) return
          // iterate tags
          for (let i = 0; i < row.length - 1; i++) {
            metrics.metric[tags[i]] = row[i]
          }
          // iterate values
          row[row.length - 1].forEach(function (row) {
            if (row[1] === 0) return
            metrics.values.push([parseInt(row[0] / 1000), row[1].toString()])
          })
          resp.data.result.push(metrics)
        })
      } catch (err) { logger.error(err, 'Error scanning fingerprints') }
    }
    logger.debug({ resp }, 'QRYN RESPONSE')
    client.send(resp)
  })
}

/**
 * Clickhouse Metrics Column Query
 * @param settings {{
 *   db: string,
 *   table: string,
 *   interval: string | number,
 *   tag: string,
 *   metric: string
 * }}
 * @param client {{
 *   code: function(number): any,
 *   send: function(string): any
 * }}
 * @param params {{
 *   start: string | number,
 *   end: string | number,
 *   shift: number | undefined
 * }}
 */
const scanClickhouse = function (settings, client, params) {
  logger.debug('Scanning Clickhouse...', settings)

  // populate matrix structure
  const resp = {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: []
    }
  }

  // TODO: Replace this template with a proper parser!
  // Check for required fields or return nothing!
  if (!settings || !settings.table || !settings.db || !settings.tag || !settings.metric) { client.send(resp); return }
  settings.interval = settings.interval ? parseInt(settings.interval) : 60
  // Normalize timefield
  if (!settings.timefield) settings.timefield = process.env.TIMEFIELD || 'record_datetime'
  else if (settings.timefield === 'false') settings.timefield = false
  // Normalize Tags
  if (settings.tag.includes('|')) { settings.tag = settings.tag.split('|').join(',') }
  // Lets query!
  let template = 'SELECT ' + settings.tag + ', groupArray((t, c)) AS groupArr FROM ('
  // Check for timefield or Bypass timefield
  if (settings.timefield) {
    const shiftSec = params.shift ? params.shift / 1000 : 0
    const timeReq = params.shift
      ? `intDiv(toUInt32(${settings.timefield} - ${shiftSec}), ${settings.interval}) * ${settings.interval} + ${shiftSec}`
      : 'intDiv(toUInt32(' + settings.timefield + '), ' + settings.interval + ') * ' + settings.interval
    template += `SELECT (${timeReq}) * 1000 AS t, ` + settings.tag + ', ' + settings.metric + ' c '
  } else {
    template += 'SELECT toUnixTimestamp(now()) * 1000 AS t, ' + settings.tag + ', ' + settings.metric + ' c '
  }
  template += 'FROM ' + settings.db + '.' + settings.table
  // Check for timefield or standalone where conditions
  if (params.start && params.end && settings.timefield) {
    template += ' PREWHERE ' + settings.timefield + ' BETWEEN ' + parseInt(params.start / 1000000000) + ' AND ' + parseInt(params.end / 1000000000)
    if (settings.where) {
      template += ' AND ' + settings.where
    }
  } else if (settings.where) {
    template += ' WHERE ' + settings.where
  }
  template += ' GROUP BY t, ' + settings.tag + ' ORDER BY t, ' + settings.tag + ')'
  template += ' GROUP BY ' + settings.tag + ' ORDER BY ' + settings.tag
  // Read-Only: Initiate a new driver connection
  if (boolEnv('READONLY')) {
    const tmp = { ...clickhouseOptions, queryOptions: { database: settings.db } }
    ch = new ClickHouse(tmp)
  }

  const stream = ch.query(template)
  // or collect records yourself
  const rows = []
  stream.on('metadata', function (columns) {
    // do something with column list
  })
  stream.on('data', function (row) {
    rows.push(row)
  })
  stream.on('error', function (err) {
    // TODO: handler error
    logger.error(err, 'error scanning clickhouse')
    resp.status = "error"
    resp.data.result = []
    client.send(resp)
  })
  stream.on('end', function () {
    logger.debug({ rows }, 'CLICKHOUSE RESPONSE')
    if (!rows || rows.length < 1) {
      resp.data.result = []
      resp.data.stats = fakeStats
    } else {
      try {
        rows.forEach(function (row) {
          const metrics = { metric: {}, values: [] }
          const tags = settings.tag.split(',').map(t => t.trim())
          // bypass empty blocks
          if (row[row.length - 1].length < 1) return
          // iterate tags
          for (let i = 0; i < row.length - 1; i++) {
            metrics.metric[tags[i]] = row[i]
          }
          // iterate values
          row[row.length - 1].forEach(function (row) {
            if (row[1] === 0) return
            metrics.values.push([parseInt(row[0] / 1000), row[1].toString()])
          })
          resp.data.result.push(metrics)
        })
      } catch (err) { logger.error(err, 'error scanning clickhouse') }
    }
    logger.debug({ resp }, 'QRYN RESPONSE')
    client.send(resp)
  })
}

/**
 *
 * @param matches {string[]} ['{ts1="a1"}', '{ts2="a2"}', ...]
 * @param res {{res: {write: (function(string)), writeHead: (function(number, {}))}}}
 */
const getSeries = async (matches) => {
  const query = transpiler.transpileSeries(matches)
  const stream = await rawRequest(query + ' FORMAT JSONEachRow', null, DATABASE_NAME(), {
    responseType: 'stream'
  })
  const res = new Transform({
    transform (chunk, encoding, callback) {
      callback(null, chunk)
    }
  })
  res.write('{"status":"success", "data":[', 'utf-8')
  let lastString = ''
  let i = 0
  let lastData = 0
  let open = true
  stream.data.on('data', (chunk) => {
    lastData = Date.now()
    const strChunk = Buffer.from(chunk).toString('utf-8')
    const lines = (lastString + strChunk).split('\n')
    lastString = lines.pop()
    lines.forEach(line => {
      if (!line) {
        return
      }
      try {
        const obj = JSON.parse(line)
        if (obj.labels) {
          res.write((i === 0 ? '' : ',') + obj.labels)
          ++i
        }
      } catch (err) {
        logger.error({ line: line, err }, 'Error parsing line')
      }
    })
  })
  const close = () => {
    if (lastString) {
      res.write((i === 0 ? '' : ',') + lastString)
    }
    res.end(']}')
    open = false
  }
  const maybeClose = () => {
    if (open && Date.now() - lastData >= 10000) {
      close()
    }
    if (open && Date.now() - lastData < 10000) {
      setTimeout(maybeClose, 10000)
    }
  }
  setTimeout(maybeClose, 10000)
  stream.data.on('end', close)
  stream.data.on('error', close)
  stream.data.on('finish', close)
  return res
}

const ping = async () => {
  await Promise.all([
    new Promise((resolve, reject) => ch.query('SELECT 1', undefined, (err) => {
      if (err) {
        logger.error(err)
      }
      err ? reject(err) : resolve(err)
    })),
    (async function () {
      try {
        await axios.get(`${getClickhouseUrl()}/?query=SELECT 1`)
      } catch (e) {
        logger.error(e)
      }
    })()
  ])
}

/* Module Exports */

/**
 *
 * @param name {string}
 * @param request {string}
 * @param options {{db : string | undefined, timeout_sec: number | undefined}}
 */
module.exports.createLiveView = (name, request, options) => {
  const db = options.db || clickhouseOptions.queryOptions.database
  const timeout = options.timeout_sec ? `WITH TIMEOUT ${options.timeout_sec}` : ''
  return axios.post(`${getClickhouseUrl()}/?allow_experimental_live_view=1`,
    `CREATE LIVE VIEW ${db}.${name} ${timeout} AS ${request}`)
}

/**
 *
 * @param db {string}
 * @param name {string}
 * @param name {string}
 * @param res {{res: {write: (function(string)), writeHead: (function(number, {}))}}}
 * @param options {{
 *     stream: (function(DataStream): DataStream)[],
 * }}
 * @returns Promise<[Promise<void>, CancelTokenSource]>
 */
module.exports.watchLiveView = async (name, db, res, options) => {
  db = db || clickhouseOptions.queryOptions.database
  const cancel = axios.CancelToken.source()
  const stream = await axios.post(`${getClickhouseUrl()}/?allow_experimental_live_view=1`,
    `WATCH ${db}.${name} FORMAT JSONEachRowWithProgress`,
    {
      responseType: 'stream',
      cancelToken: cancel.token
    })
  let buffer = []
  let lastString = []
  stream.data.on('data', /** @param data {Buffer} */data => {
    const lastNewline = data.lastIndexOf('\n')
    if (lastNewline === -1) {
      lastString.push(data)
      return
    }
    buffer.push(...lastString)
    buffer.push(data.slice(0, lastNewline + 1))
    lastString = [data.slice(lastNewline + 1)]
  })
  const flush = async () => {
    const _buffer = new Blob(buffer)
    buffer = []
    const _stream = preprocessLiveStream({ data: await _buffer.text() }, options.stream)
    const gen = _stream.toGenerator()
    for await (const item of gen()) {
      if (!item || !item.labels) {
        continue
      }
      res.res.write(item)
    }
  }

  let flushing = false
  const flushTimer = setInterval(async () => {
    if (flushing) {
      return
    }
    try {
      flushing = true
      if (!buffer.length) {
        return
      }
      await flush()
    } finally {
      flushing = false
    }
  }, 500)

  const endPromise = new Promise(resolve => {
    stream.data.on('end', () => {
      clearInterval(flushTimer)
      resolve()
    })
    stream.data.on('close', () => {
      clearInterval(flushTimer)
      resolve()
    })
    stream.data.on('error', () => {
      clearInterval(flushTimer)
      resolve()
    })
  })

  /*const endPromise = (async () => {
    const _stream = preprocessLiveStream(stream, options.stream)
    const gen = _stream.toGenerator()
    res.res.writeHead(200, {})
    for await (const item of gen()) {
      if (!item || !item.labels) {
        continue
      }
      res.res.write(item)
    }
    res.res.end()
  })()*/
  return [endPromise, cancel]
}

module.exports.createMV = async (query, id, url) => {
  const request = `CREATE MATERIALIZED VIEW ${clickhouseOptions.queryOptions.database}.${id} ` +
    `ENGINE = URL('${url}', JSON) AS ${query}`
  logger.info(`MV: ${request}`)
  await axios.post(`${getClickhouseUrl()}`, request)
}

const samplesReadTable = {
  checked: false,
  v1: false,
  v1Time: false,
  versions: {},
  getName: (fromMs) => {
    if (!samplesReadTable.checked) {
      return 'samples_read_v2_2'
    }
    if (!samplesReadTable.v1) {
      return 'samples_v3'
    }
    if (!fromMs || BigInt(fromMs + '000000') < samplesReadTable.v1Time) {
      return 'samples_read_v2_2'
    }
    return 'samples_v3'
  },
  check: async function () {
    await this.settingsVersions()
    await this._check('samples_v2')
    if (samplesReadTable.v1) {
      return
    }
    await this._check('samples')
  },
  checkVersion: function (ver, fromMs) {
    return samplesReadTable.versions[ver] < fromMs
  },
  _check: async function (tableName) {
    try {
      logger.info('checking old samples support: ' + tableName)
      samplesReadTable.checked = true
      const tablesResp = await axios.post(`${getClickhouseUrl()}/?database=${UTILS.DATABASE_NAME()}`,
        'show tables format JSON')
      samplesReadTable.v1 = tablesResp.data.data.find(row => row.name === tableName)
      if (!samplesReadTable.v1) {
        return
      }
      logger.info('checking last timestamp')
      const v1EndTime = await axios.post(`${getClickhouseUrl()}/?database=${UTILS.DATABASE_NAME()}`,
        `SELECT max(timestamp_ns) as ts FROM ${UTILS.DATABASE_NAME()}.${tableName} format JSON`)
      if (!v1EndTime.data.rows) {
        samplesReadTable.v1 = false
        return
      }
      samplesReadTable.v1 = true
      samplesReadTable.v1Time = BigInt(v1EndTime.data.data[0].ts)
      logger.warn('!!!WARNING!!! You use Qryn in the backwards compatibility mode! Some requests can be less efficient and cause OOM errors. To finish migration please look here: https://github.com/metrico/qryn/wiki/Upgrade')
    } catch (e) {
      logger.error(e.message)
      logger.error(e.stack)
      samplesReadTable.v1 = false
      logger.info('old samples table not supported')
    } finally {
      UTILS.onSamplesReadTableName(samplesReadTable.getName)
    }
  },
  settingsVersions: async function () {
    const versions = await rawRequest(
      `SELECT argMax(name, inserted_at) as _name, argMax(value, inserted_at) as _value
       FROM ${UTILS.DATABASE_NAME()}.settings${dist} WHERE type == 'update' GROUP BY fingerprint HAVING _name != '' FORMAT JSON`,
      null,
      UTILS.DATABASE_NAME()
    )
    for (const version of versions.data.data) {
      this.versions[version._name] = parseInt(version._value) * 1000
    }
    UTILS.onCheckVersion(samplesReadTable.checkVersion)
  }

}

/**
 *
 * @param query {string}
 * @param data {string | Buffer | Uint8Array}
 * @param database {string}
 * @param config {Object?}
 * @returns {Promise<AxiosResponse<any>>}
 */
const rawRequest = async (query, data, database, config) => {
  try {
    if (data && !(Buffer.isBuffer(data) || data instanceof Uint8Array || typeof data === 'string')) {
      throw new Error('data must be Buffer, Uint8Array or String: currently the data is: ' + typeof data)
    }
    if (typeof data === 'string') {
      data = Buffer.from(data, 'utf8')
    }
    if (typeof query !== 'string') {
      throw new Error('query must be String: currently the query is: ' + typeof query)
    }
    const getParams = [
      (database ? `database=${encodeURIComponent(database)}` : null),
      (data ? `query=${encodeURIComponent(query)}` : null)
    ].filter(p => p)
    const url = `${getClickhouseUrl()}/${getParams.length ? `?${getParams.join('&')}` : ''}`
    config = {
      ...(config || {}),
      method: 'post',
      url: url,
      data: data || query
    }
    return await axios(config)
  } catch (e) {
    logger.error('rawRequest error: ' + query)
    e.response?.data && logger.error(e.response.data.toString())
    throw e
  }
}

/**
 *
 * @param names {{type: string, name: string}[]}
 * @param database {string}
 * @returns {Promise<Object<string, string>>}
 */
const getSettings = async (names, database) => {
  const fps = names.map(n => UTILS.fingerPrint(JSON.stringify({ type: n.type, name: n.name }), false,
    'short-hash'))
  const settings = await rawRequest(`SELECT argMax(name, inserted_at) as _name,
        argMax(value, inserted_at) as _value
        FROM ${database}.settings${dist} WHERE fingerprint IN (${fps.join(',')}) GROUP BY fingerprint HAVING _name != '' FORMAT JSON`,
  null, database)
  return settings.data.data.reduce((sum, cur) => {
    sum[cur._name] = cur._value
    return sum
  }, {})
}

/**
 *
 * @param type {string}
 * @param name {string}
 * @param value {string}
 * @param database {string}
 * @returns {Promise<void>}
 */
const addSetting = async (type, name, value, database) => {
  const fp = UTILS.fingerPrint(JSON.stringify({ type: type, name: name }), false, 'short-hash')
  return rawRequest(`INSERT INTO ${UTILS.DATABASE_NAME()}.settings (fingerprint, type, name, value, inserted_at) FORMAT JSONEachRow`,
    JSON.stringify({
      fingerprint: fp,
      type: type,
      name: name,
      value: value,
      inserted_at: formatISO9075(new Date())
    }) + '\n', database)
}

module.exports.samplesReadTable = samplesReadTable
module.exports.databaseOptions = clickhouseOptions
module.exports.database = clickhouse
module.exports.cache = { bulk: bulk, bulk_labels: bulkLabels, labels: labels }
module.exports.scanFingerprints = scanFingerprints
module.exports.queryFingerprintsScan = queryFingerprintsScan
module.exports.instantQueryScan = instantQueryScan
module.exports.tempoQueryScan = tempoQueryScan
module.exports.tempoSearchScan = tempoSearchScan
module.exports.scanMetricFingerprints = scanMetricFingerprints
module.exports.scanClickhouse = scanClickhouse
module.exports.reloadFingerprints = reloadFingerprints
module.exports.init = initialize
module.exports.preprocessStream = preprocessStream
module.exports.capabilities = capabilities
module.exports.ping = ping
module.exports.stop = () => {
  throttler.postMessage({ type: 'end' })
  throttler.removeAllListeners('message')
  throttler.terminate()
}
module.exports.ready = () => state === 'READY'
module.exports.scanSeries = getSeries
module.exports.outputQueryStreams = outputQueryStreams
module.exports.samplesTableName = samplesTableName
module.exports.samplesReadTableName = samplesReadTableName
module.exports.getClickhouseUrl = getClickhouseUrl
module.exports.getClickhouseStream = getClickhouseStream
module.exports.preprocessLiveStream = preprocessLiveStream
module.exports.rawRequest = rawRequest
module.exports.getSettings = getSettings
module.exports.addSetting = addSetting
module.exports.scanTempo = scanTempo
module.exports.pushZipkin = pushZipkin
module.exports.queryTempoTags = queryTempoTags
module.exports.queryTempoValues = queryTempoValues
module.exports.pushOTLP = pushOTLP
module.exports.checkDB = checkDB
