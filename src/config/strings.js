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
    bookingMenu: {
      title: 'How would you like to book?',
      subtitle: 'Choose method',
      byLastVisit: 'By last visit',
      soonest: 'Soonest available',
      soonestDesc: 'Searches all physios — can take a minute',
      specificDate: 'Specific date',
      specificPhysio: 'Specific physio',
      specificClinic: 'Specific clinic',
      back: '← Back',
    },
    bookHistory: {
      verifyRequired: 'Verify your details before booking from history.',
      noPriorVisits: 'No prior physio visits found. Choose another booking method.',
      invalidNumericSelection: 'Invalid selection. Reply with a number from the list.',
      lastSeen: 'Last seen: {{date}}',
      choosePhysio: 'Choose a physio from your past visits:',
      invalidApptTypeSelection: 'Invalid appointment type selection.',
      chooseApptType: 'Choose appointment type for {{name}}:',
      invalidClinicSelection: 'Invalid clinic selection.',
      selectClinic: 'Select a clinic:',
      noSlotsForCombo: 'No available slots for that combination.',
    },
    bookSoonest: {
      selectPhysio: 'Select a practitioner for {{name}}:',
      invalidPhysioSelection: 'Invalid practitioner selection. Reply with a number from the list.',
      noApptTypesAvailable: 'No appointment types are available right now.',
      noPhysiosForType: 'No practitioners have available slots for {{name}} in the next few days.',
      invalidClinicSelection: 'Invalid clinic selection. Reply with a number from the list.',
      selectClinic: 'Clinics for {{name}}:',
      noSlotsForTypeAndPhysio: 'No slots found for {{type}} with {{physio}}.',
      noSlotsForType: 'No slots found for {{name}}.',
      chooseApptType: 'Choose appointment type:',
    },
    bookSpecificDate: {
      pickDatePage: 'Pick a date (Page {{current}}/{{total}}):',
      selectVisitType: 'Select visit type for {{date}}:',
      noApptTypesForDate: 'No appointment types available for that date.',
      noPractitionersForType: 'No practitioners offer {{name}} right now.',
      choosePhysioForDate: 'Choose a physio for {{type}} on {{date}}:',
      tryAnotherPhysio: 'Try another physio',
      noSlotsForPhysioOnDate: 'No slots on {{date}} for {{type}} with {{physio}}.',
      selectClinicForDate: 'Select a clinic for {{physio}} on {{date}}:',
      noSlotsAtClinicForDate: 'No slots for {{type}} on that date at {{clinic}}.',
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
    bookingMenu: {
      title: '你想點樣預約？',
      subtitle: '揀方式',
      byLastVisit: '按上次睇症紀錄',
      soonest: '最快有嘅時段',
      soonestDesc: '搜尋晒所有物理治療師 — 可能要等一陣',
      specificDate: '指定日期',
      specificPhysio: '指定物理治療師',
      specificClinic: '指定診所',
      back: '← 返回',
    },
    bookHistory: {
      verifyRequired: '請先驗證你嘅資料先可以按紀錄預約。',
      noPriorVisits: '搵唔到之前嘅睇症紀錄。請揀另一個預約方式。',
      invalidNumericSelection: '選擇無效，請回覆列表上嘅數字。',
      lastSeen: '上次睇症：{{date}}',
      choosePhysio: '請由你之前睇過嘅物理治療師中揀一位：',
      invalidApptTypeSelection: '預約類型選擇無效。',
      chooseApptType: '請揀 {{name}} 嘅預約類型：',
      invalidClinicSelection: '診所選擇無效。',
      selectClinic: '請揀一間診所：',
      noSlotsForCombo: '呢個組合暫時冇時段。',
    },
    bookSoonest: {
      selectPhysio: '請揀一位物理治療師嚟睇 {{name}}：',
      invalidPhysioSelection: '物理治療師選擇無效，請回覆列表上嘅數字。',
      noApptTypesAvailable: '而家冇任何預約類型可供選擇。',
      noPhysiosForType: '未來幾日冇物理治療師有 {{name}} 嘅時段。',
      invalidClinicSelection: '診所選擇無效，請回覆列表上嘅數字。',
      selectClinic: '{{name}} 嘅診所：',
      noSlotsForTypeAndPhysio: '揾唔到 {{physio}} 嘅 {{type}} 時段。',
      noSlotsForType: '揾唔到 {{name}} 嘅時段。',
      chooseApptType: '請揀預約類型：',
    },
    bookSpecificDate: {
      pickDatePage: '揀日期（第 {{current}}/{{total}} 頁）：',
      selectVisitType: '請揀 {{date}} 嘅預約類型：',
      noApptTypesForDate: '嗰日冇任何預約類型可供選擇。',
      noPractitionersForType: '而家冇物理治療師提供 {{name}}。',
      choosePhysioForDate: '請揀一位喺 {{date}} 睇 {{type}} 嘅物理治療師：',
      tryAnotherPhysio: '試下另一位物理治療師',
      noSlotsForPhysioOnDate: '{{date}} 冇 {{physio}} 嘅 {{type}} 時段。',
      selectClinicForDate: '請揀 {{physio}} 喺 {{date}} 嘅診所：',
      noSlotsAtClinicForDate: '嗰日喺 {{clinic}} 冇 {{type}} 嘅時段。',
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
    bookingMenu: {
      title: '您想如何预约？',
      subtitle: '选择方式',
      byLastVisit: '按上次就诊记录',
      soonest: '最快可预约时段',
      soonestDesc: '搜索所有理疗师 — 可能需要一分钟',
      specificDate: '指定日期',
      specificPhysio: '指定理疗师',
      specificClinic: '指定诊所',
      back: '← 返回',
    },
    bookHistory: {
      verifyRequired: '请先验证您的信息才能按记录预约。',
      noPriorVisits: '未找到之前的就诊记录。请选择其他预约方式。',
      invalidNumericSelection: '选择无效，请回复列表中的数字。',
      lastSeen: '上次就诊：{{date}}',
      choosePhysio: '请从您之前就诊过的理疗师中选择：',
      invalidApptTypeSelection: '预约类型选择无效。',
      chooseApptType: '请选择 {{name}} 的预约类型：',
      invalidClinicSelection: '诊所选择无效。',
      selectClinic: '请选择一间诊所：',
      noSlotsForCombo: '该组合暂无可用时段。',
    },
    bookSoonest: {
      selectPhysio: '请选择一位理疗师看诊 {{name}}：',
      invalidPhysioSelection: '理疗师选择无效，请回复列表中的数字。',
      noApptTypesAvailable: '目前没有可预约的类型。',
      noPhysiosForType: '未来几天没有理疗师有 {{name}} 的时段。',
      invalidClinicSelection: '诊所选择无效，请回复列表中的数字。',
      selectClinic: '{{name}} 的诊所：',
      noSlotsForTypeAndPhysio: '未找到 {{physio}} 的 {{type}} 时段。',
      noSlotsForType: '未找到 {{name}} 的时段。',
      chooseApptType: '请选择预约类型：',
    },
    bookSpecificDate: {
      pickDatePage: '选择日期（第 {{current}}/{{total}} 页）：',
      selectVisitType: '请选择 {{date}} 的预约类型：',
      noApptTypesForDate: '当天没有可预约的类型。',
      noPractitionersForType: '目前没有理疗师提供 {{name}}。',
      choosePhysioForDate: '请选择一位在 {{date}} 看 {{type}} 的理疗师：',
      tryAnotherPhysio: '尝试另一位理疗师',
      noSlotsForPhysioOnDate: '{{date}} 没有 {{physio}} 的 {{type}} 时段。',
      selectClinicForDate: '请选择 {{physio}} 在 {{date}} 的诊所：',
      noSlotsAtClinicForDate: '当天在 {{clinic}} 没有 {{type}} 的时段。',
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
