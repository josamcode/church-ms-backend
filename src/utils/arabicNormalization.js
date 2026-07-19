const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/g;
const TATWEEL = /\u0640/g;
const DIGIT_MAP = Object.freeze({
  '٠': '0', '۰': '0',
  '١': '1', '۱': '1',
  '٢': '2', '۲': '2',
  '٣': '3', '۳': '3',
  '٤': '4', '۴': '4',
  '٥': '5', '۵': '5',
  '٦': '6', '۶': '6',
  '٧': '7', '۷': '7',
  '٨': '8', '۸': '8',
  '٩': '9', '۹': '9',
});

function cleanExactName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ');
}

function normalizeArabicComparison(value) {
  return cleanExactName(value)
    .replace(ARABIC_DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ئ/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/[٠-٩۰-۹]/g, (digit) => DIGIT_MAP[digit] || digit)
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('ar');
}

module.exports = {
  cleanExactName,
  normalizeArabicComparison,
};
