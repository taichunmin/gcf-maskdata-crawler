const _ = require('lodash')
const axios = require('axios')
const Papa = require('papaparse')

/**
 * 取得 process.env.[key] 的輔助函式，且可以有預設值
 */
exports.getenv = (key, defaultval) => {
  return _.get(process, ['env', key], defaultval)
}

const log = (...args) => {
  _.each(args, (arg, i) => {
    console.log(i, _.truncate(JSON.stringify(arg), { length: 1000 }))
  })
}

exports.getCsv = async url => {
  url = new URL(url)
  url.searchParams.set('cachebust', +new Date())
  const csv = _.trim(_.get(await axios.get(url.href), 'data'))
  return _.get(Papa.parse(csv, {
    encoding: 'utf8',
    header: true,
  }), 'data', [])
}

const CSV_MASK = 'https://data.nhi.gov.tw/resource/mask/maskdata.csv'
exports.getMasks = async () => {
  const masks = await exports.getCsv(CSV_MASK)
  console.log(`取得 ${masks.length} 筆口罩數量資料`)
  return _.fromPairs(_.map(masks, mask => [
    mask['醫事機構代碼'],
    {
      id: mask['醫事機構代碼'],
      adult: _.parseInt(mask['成人口罩總剩餘數']),
      child: _.parseInt(mask['兒童口罩剩餘數']),
      mask_updated: mask['來源資料時間'],
    }
  ]))
}

const CSV_STORE = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT4tWc7zUcHQQ8LC_0276aOZNcIBu544YB9XrSRz7oq66q5lE3RHN5Ix2-4S3NL4bL-0zi5nKzE13eX/pub?gid=0&single=true&output=csv'
exports.getStores = async () => {
  const stores = await exports.getCsv(CSV_STORE)
  console.log(`取得 ${stores.length} 筆店家資料`)
  return stores
}

exports.unparseCsv = (data) => {
  return Papa.unparse(data, {
    header: true
  })
}

exports.gcsCsvUpload = (() => {
  const GCS_BUCKET = exports.getenv('GCS_BUCKET')
  if (!GCS_BUCKET) return () => { throw new Error('GCS_BUCKET is required') }

  const { Storage } = require('@google-cloud/storage')
  const storage = new Storage()
  const bucket = storage.bucket(GCS_BUCKET)
  return async (dest, data, maxAge = 30) => {
    const file = bucket.file(dest)
    await file.save(data, {
      gzip: true,
      // public: true,
      validation: 'crc32c',
      metadata: {
        cacheControl: `public, max-age=${maxAge}`,
        contentLanguage: 'zh',
        contentType: 'text/csv'
      }
    })
  }
})()

exports.main = async () => {
  const [masks, stores] = await Promise.all([
    exports.getMasks(),
    exports.getStores(),
  ])
  // log(masks, stores)

  _.each(stores, store => {
    const mask = _.get(masks, store.id)
    if (!mask) return
    _.each(['adult', 'child', 'mask_updated'], field => {
      store[field] = mask[field]
    })
  })

  await exports.gcsCsvUpload('ncov-mask-map/maskdata.csv', exports.unparseCsv(stores))
}
