const _ = require('lodash')
const { google } = require('googleapis')
const axios = require('axios')
const Papa = require('papaparse')

const MASKDATA_URL = 'https://data.nhi.gov.tw/resource/mask/maskdata.csv'
const SHEETS_ID = '1RZtzK7HRBk7yT9z7JYoLSXNqKEuK4JJn9Ve58kEPy4w'

const log = (...args) => {
  _.each(args, (arg, i) => {
    console.log(i, _.truncate(JSON.stringify(arg), { length: 1000 }))
  })
}

exports.getMaskdata = async () => {
  const url = new URL(MASKDATA_URL)
  url.searchParams.set('cachebust', +new Date())
  const csv = await axios.get(url.href)
  const masks = await new Promise((resolve, reject) => {
    Papa.parse(_.trim(csv.data), {
      encoding: 'utf8',
      header: true,
      error: reject,
      complete: results => { resolve(_.get(results, 'data', [])) }
    })
  })
  log(`取得 ${masks.length} 筆口罩數量資料`)
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

  const masks = await exports.getMaskdata()
  // log(_.get(masks, '0145080011'))

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

  const data = _.map(['adult', 'child', 'mask_updated'], field => ({
    range: `database!${colsA1[field]}2:${colsA1[field]}`,
    majorDimension: 'COLUMNS',
    values: [_.map(storeIds, id => _.toString(_.get(masks, [id, field], '')))]
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
