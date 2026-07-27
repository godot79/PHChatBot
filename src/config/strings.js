'use strict';

/**
 * Incremental bot-copy string catalog. Only covers the language gate, region
 * gate copy, and main-menu copy so far — the rest of ChatbotEngine.js's
 * inline strings are migrated in later, separate passes.
 *
 * yue/zh entries below are AI-drafted, not yet reviewed by a native speaker.
 * Fine for this first pass (menu/navigation labels only), but must get a
 * native-speaker sanity check before any clinical/booking-policy copy is
 * added here.
 */
const STRINGS = {
  en: {
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

function t(languageCode, keyPath) {
  const path = keyPath.split('.');
  const walk = (obj) => path.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
  return walk(STRINGS[languageCode]) ?? walk(STRINGS.en) ?? keyPath;
}

module.exports = { STRINGS, t };
