import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { parseCsv, parseDirectory, parseGeoNames, titleCase } from '../src/modules/pin-directory/parse.js'
import { ADMIN_ORIGIN, PASSWORD, createTestApi, type TestApi } from './fakes.js'

async function signedIn(api: TestApi): Promise<string> {
  await request(api.app).post('/admin/auth/login').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', password: PASSWORD })
  const response = await request(api.app).post('/admin/auth/verify').set('Origin', ADMIN_ORIGIN).send({ email: 'owner@example.com', code: api.sentCodes.at(-1)?.code })
  return ((response.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? ''
}

describe('reading the PIN directory file', () => {
  it('reads quoted cells, commas and line breaks inside quotes, CRLF line endings and a leading BOM', () => {
    const text = '﻿pincode,officename,district,statename\r\n382010,"Sector 10, Gandhinagar S.O",GANDHINAGAR,GUJARAT\r\n"382011","Say ""hi""",GANDHINAGAR,GUJARAT\r\n\r\n'
    expect(parseCsv(text)).toEqual([['pincode', 'officename', 'district', 'statename'], ['382010', 'Sector 10, Gandhinagar S.O', 'GANDHINAGAR', 'GUJARAT'], ['382011', 'Say "hi"', 'GANDHINAGAR', 'GUJARAT']])
    expect(parseCsv('a,b\n1,"x\ny"')).toEqual([['a', 'b'], ['1', 'x\ny']])
  })

  it('cleans names, drops post-office suffixes, skips bad PINs and keeps each PIN + office once', () => {
    const cells = parseCsv([
      'CircleName,RegionName,DivisionName,OfficeName,Pincode,OfficeType,Delivery,District,StateName',
      'Gujarat Circle,Ahmedabad,Gandhinagar,SECTOR-10 S.O,382010,S.O,Delivery,GANDHINAGAR,GUJARAT',
      'Gujarat Circle,Ahmedabad,Gandhinagar,Sector-10 S.O.,382010,S.O,Delivery,GANDHINAGAR,GUJARAT',
      'Gujarat Circle,Ahmedabad,Gandhinagar,Kolavada B.O,382030,B.O,Delivery,GANDHINAGAR,GUJARAT',
      'x,x,x,Bad Pin,38201,S.O,Delivery,GANDHINAGAR,GUJARAT',
      'x,x,x,Leading Zero,012345,S.O,Delivery,GANDHINAGAR,GUJARAT',
      'x,x,x,No State,382040,S.O,Delivery,GANDHINAGAR,',
    ].join('\n'))
    const { rows, read, skipped } = parseDirectory(cells)
    expect(rows).toEqual([
      { pinCode: '382010', officeName: 'Sector-10', district: 'Gandhinagar', state: 'Gujarat' },
      { pinCode: '382030', officeName: 'Kolavada', district: 'Gandhinagar', state: 'Gujarat' },
    ])
    expect([read, skipped]).toEqual([6, 3])
  })

  it('refuses a file that has no PIN or state column, instead of importing nothing', () => {
    expect(() => parseDirectory(parseCsv('name,city\nA,B'))).toThrow(/PIN code column/)
    expect(() => parseDirectory(parseCsv('pincode,district\n382010,X'))).toThrow(/state column/)
    expect(() => parseDirectory([])).toThrow(/empty/)
  })

  it('reads the GeoNames India file, keeping names as written and ignoring other countries and bad lines', () => {
    const text = [
      'IN\t382010\tSector 10\tGujarat\tGJ\tGandhinagar\t\t\t\t23.2\t72.6\t4',
      'IN\t382010\tSector 10\tGujarat\tGJ\tGandhinagar\t\t\t\t23.2\t72.6\t4',
      'IN\t110001\tNew Delhi G.P.O.\tDelhi\tDL\tNew Delhi\t\t\t\t28.6\t77.2\t4',
      'IN\t12345\tBad pin\tGujarat\tGJ\tGandhinagar',
      'US\t90210\tBeverly Hills\tCalifornia\tCA\tLos Angeles',
      '',
    ].join('\r\n')
    const { rows, skipped } = parseGeoNames(text)
    expect(rows).toEqual([
      { pinCode: '382010', officeName: 'Sector 10', district: 'Gandhinagar', state: 'Gujarat' },
      { pinCode: '110001', officeName: 'New Delhi G.P.O.', district: 'New Delhi', state: 'Delhi' },
    ])
    expect(skipped).toBe(1)
  })

  it('capitalises names the way people write them', () => {
    expect(titleCase('  DADRA  AND NAGAR HAVELI ')).toBe('Dadra And Nagar Haveli')
    expect(titleCase('SECTOR-10 (EAST)')).toBe('Sector-10 (East)')
  })
})

describe('PIN directory lookups (admin)', () => {
  it('needs a signed-in admin', async () => {
    const api = await createTestApi()
    expect((await request(api.app).get('/admin/pin-directory/states')).status).toBe(401)
  })

  it('lists states, a state\'s districts and a district\'s PIN codes with their post offices', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    const get = (path: string) => request(api.app).get(path).set('Cookie', cookie)
    expect((await get('/admin/pin-directory/states')).body.states).toEqual(['Gujarat', 'Maharashtra'])
    expect((await get('/admin/pin-directory/districts?state=gujarat')).body.districts).toEqual(['Ahmedabad', 'Gandhinagar'])
    const pins = await get('/admin/pin-directory/pins?state=Gujarat&district=Gandhinagar')
    expect(pins.body.pins).toEqual([{ pinCode: '382010', offices: ['Sector 10'] }, { pinCode: '382011', offices: ['Sector 11', 'Sector 11 Colony'] }])
    expect((await get('/admin/pin-directory/pins?state=Gujarat&district=Nowhere')).body.pins).toEqual([])
  })

  it('refuses a missing state or district', async () => {
    const api = await createTestApi()
    const cookie = await signedIn(api)
    expect((await request(api.app).get('/admin/pin-directory/districts').set('Cookie', cookie)).status).toBe(400)
    expect((await request(api.app).get('/admin/pin-directory/pins?state=Gujarat').set('Cookie', cookie)).body.error.details[0].field).toBe('district')
  })
})
