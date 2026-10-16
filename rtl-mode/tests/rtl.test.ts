import { describe, expect, test } from 'claude-code/testing'

import { LRE, LRM, PDF, RLE, RLM, rtlText } from '../hooks/rtl'

const HE = RLM + RLE
const EN = LRM + LRE

describe('rtlText', () => {
  test('an English line wraps a Hebrew quote inside its marks, English word included', () => {
    expect(rtlText('Run "התקן את הכלי עם npm עכשיו" first')).toBe(
      `${EN}Run "${RLE}התקן את הכלי עם npm עכשיו${PDF}" first`,
    )
  })

  test('an English line wraps a Hebrew run with the punctuation that ends it', () => {
    expect(rtlText('The words שלום עולם, mean hello world')).toBe(
      `${EN}The words ${RLE}שלום עולם,${PDF} mean hello world`,
    )
  })

  test('gershayim between letters is not a quote', () => {
    expect(rtlText('He joined צה"ל in 2010')).toBe(`${EN}He joined ${RLE}צה"ל${PDF} in 2010`)
  })

  test('a Hebrew list item wraps its English code span outside the backticks', () => {
    expect(rtlText('- הרץ את `npm test` בתיקייה')).toBe(
      `- ${HE}הרץ את ${LRE}\`npm test\`${PDF} בתיקייה`,
    )
  })

  test('the marks go after a heading, a quote mark and a number', () => {
    expect(rtlText('## כותרת ראשית')).toBe(`## ${HE}כותרת ראשית`)
    expect(rtlText('> 1. צעד ראשון')).toBe(`> 1. ${HE}צעד ראשון`)
  })

  test('direction ignores quotes, code spans and links', () => {
    const line = 'הוא אמר "hello world and many more English words" ב [the docs](https://example.com)'
    expect(rtlText(line)).toBe(HE + line)
  })

  test('lines in a code block and lines without Hebrew stay as they were', () => {
    const text = 'Plain English\n```\nשלום world\n```\nstill English'
    expect(rtlText(text)).toBe(text)
  })

  test('a table row is rewritten cell by cell', () => {
    expect(rtlText('| שם | name | `npm` של הפרויקט |')).toBe(
      `| ${HE}שם | name | ${HE}${LRE}\`npm\`${PDF} של הפרויקט |`,
    )
  })
})
