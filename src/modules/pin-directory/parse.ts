/**
 * Reading the national PIN directory file (the free India Post list on data.gov.in) into clean rows.
 * No database here: the import script and the tests both use these plain functions.
 */
export type DirectoryRow = { pinCode: string; officeName: string; district: string; state: string }

/** Splits CSV text into rows of cells. Handles quoted cells, doubled quotes, commas and line breaks inside quotes, CRLF and a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1 } else quoted = false
      } else cell += character
    } else if (character === '"') quoted = true
    else if (character === ',') { row.push(cell); cell = '' }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      row.push(cell); cell = ''
      if (row.some(value => value.trim() !== '')) rows.push(row)
      row = []
    } else cell += character
  }
  row.push(cell)
  if (row.some(value => value.trim() !== '')) rows.push(row)
  return rows
}

const squash = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '')
const COLUMN_NAMES = {
  pinCode: ['pincode', 'pin', 'postalcode'],
  officeName: ['officename', 'office', 'postoffice'],
  district: ['district', 'districtname'],
  state: ['statename', 'state'],
} as const

/** "GANDHINAGAR" -> "Gandhinagar", "SECTOR-10" -> "Sector-10". Capital letter after a space, hyphen, slash or bracket. */
export function titleCase(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_match, before: string, letter: string) => before + letter.toUpperCase())
}

/** Post office suffixes carry no meaning for a customer ("Sector 10 S.O" -> "Sector 10"). */
const cleanOffice = (value: string) => titleCase(value.replace(/\s+(b\.?o\.?|s\.?o\.?|h\.?o\.?|g\.?p\.?o\.?)\s*$/i, ''))

export type ParsedDirectory = { rows: DirectoryRow[]; read: number; skipped: number }

/**
 * Turns the file's cells into clean rows: a 6-digit PIN, the office, district and state in normal capitalisation.
 * Rows without a valid PIN or a state are skipped and counted; the same PIN + office is kept once.
 * Throws when the file has no PIN-code column, so a wrong file is noticed instead of silently importing nothing.
 */
export function parseDirectory(cells: string[][], options: { keepCase?: boolean } = {}): ParsedDirectory {
  const [header, ...body] = cells
  if (!header) throw new Error('The file is empty.')
  const names = header.map(squash)
  const find = (options: readonly string[]) => names.findIndex(name => options.includes(name))
  const columns = { pinCode: find(COLUMN_NAMES.pinCode), officeName: find(COLUMN_NAMES.officeName), district: find(COLUMN_NAMES.district), state: find(COLUMN_NAMES.state) }
  if (columns.pinCode === -1) throw new Error('No PIN code column was found. The first line of the file should name its columns, such as pincode, officename, district, statename.')
  if (columns.state === -1) throw new Error('No state column was found. The first line of the file should name its columns, such as pincode, officename, district, statename.')

  const seen = new Set<string>()
  const rows: DirectoryRow[] = []
  let skipped = 0
  for (const line of body) {
    const pinCode = (line[columns.pinCode] ?? '').trim()
    const name = (value: string) => (options.keepCase ? value.trim().replace(/\s+/g, ' ') : titleCase(value))
    const state = name(line[columns.state] ?? '')
    if (!/^[1-9][0-9]{5}$/.test(pinCode) || !state) { skipped += 1; continue }
    const officeName = columns.officeName === -1 ? '' : (options.keepCase ? name(line[columns.officeName] ?? '') : cleanOffice(line[columns.officeName] ?? '')).slice(0, 120)
    const district = columns.district === -1 ? '' : name(line[columns.district] ?? '').slice(0, 80)
    const key = `${pinCode}|${officeName.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ pinCode, officeName, district, state: state.slice(0, 60) })
  }
  return { rows, read: body.length, skipped }
}

/**
 * Reads the GeoNames India file (`IN.txt` from download.geonames.org/export/zip, tab-separated, no header line):
 * country, postal code, place, state, state code, district, district code, ... Names are already well written, so they keep their case.
 * Lines for other countries are ignored. Credit: GeoNames, CC BY 4.0.
 */
export function parseGeoNames(text: string): ParsedDirectory {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
  const cells = lines.map(line => line.split('\t')).filter(fields => fields[0] === 'IN').map(fields => [fields[1] ?? '', fields[2] ?? '', fields[5] ?? '', fields[3] ?? ''])
  return parseDirectory([['pincode', 'officename', 'district', 'statename'], ...cells], { keepCase: true })
}
