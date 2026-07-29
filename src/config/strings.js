'use strict';

/**
 * Incremental bot-copy string catalog. Covers the language gate, region gate
 * copy, main-menu copy, and (Phase 2) global error/fallback copy so far —
 * the rest of ChatbotEngine.js's inline strings are migrated in later,
 * separate passes.
 *
 * yue/zh entries below are AI-drafted, not yet reviewed by a native speaker.
 * Fine for this first pass, but must get a native-speaker sanity check
 * before any clinical/booking-policy copy is added here.
 *
 * t() supports {{placeholder}} interpolation via a third `params` arg, e.g.
 * t(lang, 'common.example', { name: 'Dr Tan' }) replaces {{name}} in the
 * resolved string. Needed for Phase 2 sub-batches that interpolate
 * Cliniko-derived names into otherwise-translated sentences.
 */
const STRINGS = {
  en: {
    common: {
      unexpectedError: 'We encountered an unexpected error processing your request. You can continue using the menu below, or contact support if the issue persists.',
      fallbackNotUnderstood: "I'm sorry, I didn't understand that.",
      optionsNotUnderstood: 'Your response is not understood. Here are the options. Try again.',
      invalidBookingMethod: 'Please reply with a valid booking method (1–5).',
      cannotProceedBooking: 'Cannot proceed with booking. Please start again.',
    },
    region: {
      promptBody: 'Please select your region:',
      buttonLabel: 'Select region',
    },
    mainMenu: {
      welcomeHeader: '👋 *Welcome to Prohealth Asia*\n\n',
      unverifiedPrompt: '*New here? Tap Register below 👇*\nAlready a patient? Tap Book or Manage.',
      verifiedBody: 'What would you like to do?',
      book: 'Book Appointment',
      cancel: 'Cancel Appointment',
      reschedule: 'Reschedule',
      changeCountry: 'Change Country',
      changeLanguage: 'Change Language',
      logout: 'Logout & Delete My Data',
      register: 'Register as new patient',
      bookOrManage: 'Book or Manage',
      viewFees: 'View Fees',
      viewLocations: 'View Locations',
    },
  },
  yue: {
    common: {
      unexpectedError: '處理你嘅請求時發生咗未預期嘅錯誤。你可以繼續用返下面嘅選單，或者如果問題持續就聯絡我哋。',
      fallbackNotUnderstood: '唔好意思，我唔明白你講咩。',
      optionsNotUnderstood: '你嘅回覆我哋睇唔明。呢度係選項，請再試多次。',
      invalidBookingMethod: '請回覆一個有效嘅預約方式（1–5）。',
      cannotProceedBooking: '未能繼續預約，請重新開始。',
    },
    region: {
      promptBody: '請選擇你所喺嘅地區：',
      buttonLabel: '選擇地區',
    },
    mainMenu: {
      welcomeHeader: '👋 *歡迎嚟到 Prohealth Asia*\n\n',
      unverifiedPrompt: '*第一次嚟？撳下面嘅「登記」👇*\n已經係病人？撳「預約 / 管理」。',
      verifiedBody: '你想做啲咩？',
      book: '預約',
      cancel: '取消預約',
      reschedule: '更改預約時間',
      changeCountry: '更改地區',
      changeLanguage: '更改語言',
      logout: '登出並刪除我嘅資料',
      register: '登記做新症',
      bookOrManage: '預約 / 管理',
      viewFees: '查看收費',
      viewLocations: '查看地點',
    },
  },
  zh: {
    common: {
      unexpectedError: '处理您的请求时发生了意外错误。您可以继续使用下面的菜单，如果问题持续，请联系我们。',
      fallbackNotUnderstood: '抱歉，我不明白您的意思。',
      optionsNotUnderstood: '无法理解您的回复。以下是选项，请重新尝试。',
      invalidBookingMethod: '请回复有效的预约方式（1–5）。',
      cannotProceedBooking: '无法继续预约，请重新开始。',
    },
    region: {
      promptBody: '请选择您所在的地区：',
      buttonLabel: '选择地区',
    },
    mainMenu: {
      welcomeHeader: '👋 *欢迎来到 Prohealth Asia*\n\n',
      unverifiedPrompt: '*第一次来？点击下面的"注册"👇*\n已经是患者？点击"预约/管理"。',
      verifiedBody: '您想做什么？',
      book: '预约',
      cancel: '取消预约',
      reschedule: '更改预约时间',
      changeCountry: '更改地区',
      changeLanguage: '更改语言',
      logout: '登出并删除我的数据',
      register: '注册为新患者',
      bookOrManage: '预约/管理',
      viewFees: '查看收费',
      viewLocations: '查看地点',
    },
  },
};

function t(languageCode, keyPath, params) {
  const path = keyPath.split('.');
  const walk = (obj) => path.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
  const resolved = walk(STRINGS[languageCode]) ?? walk(STRINGS.en) ?? keyPath;
  if (!params || typeof resolved !== 'string') return resolved;
  return Object.keys(params).reduce(
    (str, key) => str.replace(new RegExp(`{{${key}}}`, 'g'), params[key]),
    resolved
  );
}

module.exports = { STRINGS, t };
