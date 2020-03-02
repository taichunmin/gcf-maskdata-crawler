const _ = require('lodash')
const { google } = require('googleapis')
const axios = require('axios')
const Joi = require('@hapi/joi')
const Papa = require('papaparse')

const SHEETS_ID = '1RZtzK7HRBk7yT9z7JYoLSXNqKEuK4JJn9Ve58kEPy4w'

const log = (...args) => {
  _.each(args, (arg, i) => {
    console.log(i, _.truncate(JSON.stringify(arg), { length: 1000 }))
  })
}

exports.joiStore = (() => {
  const schema = Joi.object({
    id: Joi.string().regex(/^\d+$/).required(),
    name: Joi.string().trim().required(),
    tel: Joi.string().replace(/\s/g, '').required(),
    address: Joi.string().trim().required(),
    type: Joi.string().trim().required(),
    end: Joi.string().trim().equal('').strip(),
    time: Joi.string().replace(/星期.{3}看診、?/g, '1').replace(/星期.{3}休診、?/g, '0').regex(/^[01]{21}$/).required(),
    notice: Joi.string().trim().empty(Joi.any().equal('-')).default(''),
  })
  return store => schema.validateAsync(store, { stripUnknown: true })
})()

exports.getStoreCsv = async url => {
  url = new URL(url)
  url.searchParams.set('cachebust', +new Date())
  let csv = _.trim(_.get(await axios.get(url.href), 'data'))

  // header 特殊處理
  csv = csv.replace(/^[^\n]+/, 'id,name,f1,tel,address,f2,type,f3,f4,end,time,notice')

  const stores = _.get(Papa.parse(csv, {
    encoding: 'utf8',
    header: true,
  }), 'data', [])
  for (let i = 0; i < stores.length; i++) {
    try {
      stores[i] = await exports.joiStore(stores[i])
    } catch (err) {
      stores[i].invalid = true
    }
  }
  return _.filter(stores, store => !store.invalid)
}

const CSV_PHARMACY = 'https://data.nhi.gov.tw/Datasets/DatasetResource.ashx?rId=A21030000I-D21005-004'
const CSV_CLINIC = 'https://data.nhi.gov.tw/Datasets/DatasetResource.ashx?rId=A21030000I-D21004-004'
/** 取得診所及藥局的資料並解析 */
exports.getStores = async () => {
  const stores = _.flatten(await Promise.all([
    exports.getStoreCsv(CSV_PHARMACY),
    exports.getStoreCsv(CSV_CLINIC),
  ]))
  console.log(`取得 ${stores.length} 筆資料`)
  return _.mapKeys(stores, 'id')
}

const authSheetsAPI = async () => {
  const auth = await google.auth.getClient({
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets'
    ]
  })
  return google.sheets({ version: 'v4', auth })
}

const sheetsValuesGet = async (sheetsAPI, request) => {
  return new Promise((resolve, reject) => {
    sheetsAPI.spreadsheets.values.get(
      request,
      (err, response) => err ? reject(err) : resolve(_.get(response, 'data.values'))
    )
  })
}

const sheetsValuesBatchUpdate = async (sheetsAPI, request) => {
  return new Promise((resolve, reject) => {
    sheetsAPI.spreadsheets.values.batchUpdate(
      request,
      (err, response) => err ? reject(err) : resolve(_.get(response, 'data'))
    )
  })
}

const cellToA1 = (() => {
  const map1 = _.fromPairs(_.zip('0123456789abcdefghijklmnop'.split(''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')))
  const strtr = str => _.map(str, c => _.get(map1, c, '?')).join('')
  const colToA1 = col => {
    let len = 1
    while (col >= (26 ** (len + 1) - 1) / 25) len++
    col -= (26 ** len - 1) / 25
    return _.padStart(strtr(col.toString(26)), len, 'A')
  }
  return (col, row) => {
    if (_.isInteger(col)) col = colToA1(col)
    if (_.isNil(col)) col = ''
    if (_.isNil(row)) row = ''
    return `${col}${row}`
  }
})()

exports.main = async () => {
  const sheetsAPI = await authSheetsAPI()

  const stores = await exports.getStores()
  // log(_.get(stores, '2317040012'))

  // get sheets headers
  const sheetHeaders = _.get(await sheetsValuesGet(sheetsAPI, {
    dateTimeRenderOption: 'FORMATTED_STRING',
    majorDimension: 'ROWS',
    range: 'database!1:1',
    spreadsheetId: SHEETS_ID,
    valueRenderOption: 'UNFORMATTED_VALUE',
  }), 0, [])
  const colsA1 = _.fromPairs(_.map(sheetHeaders, (v, k) => [v, cellToA1(k + 1)]))
  // log(colsA1)

  const storeIds = _.get(await sheetsValuesGet(sheetsAPI, {
    dateTimeRenderOption: 'FORMATTED_STRING',
    majorDimension: 'COLUMNS',
    range: `database!${colsA1.id}2:${colsA1.id}`,
    spreadsheetId: SHEETS_ID,
    valueRenderOption: 'UNFORMATTED_VALUE',
  }), 0, [])
  // log(_.slice(storeIds, 0, 10))

  const data = _.map(['name', 'tel', 'address', 'type', 'time', 'notice'], field => ({
    range: `database!${colsA1[field]}2:${colsA1[field]}`,
    majorDimension: 'COLUMNS',
    values: [_.map(storeIds, id => _.get(stores, [id, field], ''))]
  }))
  // log(...data)
  log(await sheetsValuesBatchUpdate(sheetsAPI, {
    spreadsheetId: SHEETS_ID,
    resource: {
      includeValuesInResponse: false,
      valueInputOption: 'RAW',
      data,
    }
  }))
}
