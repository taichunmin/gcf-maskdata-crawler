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

exports.joiOpened = (() => {
  const schema = Joi.object({
    id: Joi.string().alphanum().required(),
    name: Joi.string().trim().required(),
    time: Joi.string().replace(/N/g, '1').replace(/Y/g, '0').regex(/^[01]{21}$/).empty('').default(''),
    notice: Joi.string().trim().empty(Joi.any().equal('-', '')).default(''),
    opened: Joi.string().trim().equal('0').strip(),
  })
  return opened => schema.validateAsync(opened, { stripUnknown: true })
})()

exports.getOpenedCsv = async url => {
  url = new URL(url)
  url.searchParams.set('cachebust', +new Date())
  let csv = _.trim(_.get(await axios.get(url.href), 'data'))

  // header 特殊處理
  csv = csv.replace(/^[^\n]+/, 'id,name,f3,f4,f5,time,notice,opened,updatedAt')

  const openeds = _.get(Papa.parse(csv, {
    encoding: 'utf8',
    header: true,
  }), 'data', [])
  for (let i = 0; i < openeds.length; i++) {
    try {
      openeds[i] = await exports.joiOpened(openeds[i])
    } catch (err) {
      // if (!openeds[i].end) console.log(err.message, openeds[i])
      openeds[i].invalid = true
    }
  }
  return _.filter(openeds, opened => !opened.invalid)
}

exports.getOpeneds = async () => {
  const openeds = await exports.getOpenedCsv('https://data.nhi.gov.tw/resource/Opendata/%E5%85%A8%E6%B0%91%E5%81%A5%E5%BA%B7%E4%BF%9D%E9%9A%AA%E7%89%B9%E7%B4%84%E9%99%A2%E6%89%80%E5%9B%BA%E5%AE%9A%E6%9C%8D%E5%8B%99%E6%99%82%E6%AE%B5.csv')
  console.log(`取得 ${openeds.length} 筆資料`)
  return _.mapKeys(openeds, 'id')
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

  const stores = await exports.getOpeneds()
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

  const data = _.map(['time', 'notice'], field => ({
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
