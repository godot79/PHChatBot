'use strict';

const { buildGoogleMapsLink, extractPhone, formatClinicForWhatsApp } = require('../../../src/core/ClinicFormatter');

// ─── Region fixtures (shapes taken from live Cliniko data) ───────────────────

const fixtures = {
  // SG: 1 clinic, Telephone: prefix, full address with post_code
  SG: [
    {
      business_name: 'Prohealth In Touch Physiotherapy',
      address_1: '22 Malacca Street',
      address_2: '#14-02 RB Capital Building',
      city: 'Singapore',
      post_code: '048980',
      contact_information: 'Telephone: +65 6533 0968\nWhatsApp: +65 9111 5623\nEmail: admin@intouchphysio.com',
    },
  ],

  // HK: 4 clinics; Phone: and Tel: prefixes; some post_code null or empty
  HK: [
    {
      business_name: 'A. Prohealth Sports & Spinal Physiotherapy Centres (WS)',
      address_1: '18F, One Silver Fortune Plaza',
      address_2: '1 Wellington Street',
      city: 'Central',
      post_code: '',
      contact_information: 'Phone: 25300073\nFax: 2530 2797',
    },
    {
      business_name: 'B. ProHealth Sports and Spinal Physiotherapy Centres (WWH)',
      address_1: 'Rm 1202, World Wide House',
      address_2: '19 Des Veoux Road',
      city: 'Central',
      post_code: null,
      contact_information: 'Tel: 25303022\nFax: 25305400',
    },
    {
      business_name: 'C. Prohealth Sports and Spinal Physiotherapy Centres (TST)',
      address_1: 'Suites 1326-27 13F Ocean Centre Harbour City',
      address_2: '5號 Canton Rd, Tsim Sha Tsui',
      city: 'Kowloon',
      post_code: null,
      contact_information: 'Telephone: (852) 2666 5219\nWhatsApp:(852) 69463575\nEmail: tstappt@sportsandspinal.hk',
    },
    {
      business_name: 'D. Prohealth Sports and Spinal Physiotherapy Centre (QB)',
      address_1: 'RM 1706, 17/F FWD Tower',
      address_2: 'Taikoo Place, 979 Kings Road',
      city: 'Quarry Bay',
      post_code: null,
      contact_information: 'Whatsapp: 84001760\nPhone: 25300336\nFax: 25300068',
    },
  ],

  // IN: 1 clinic; address_1 is a descriptive parenthetical; Phone: prefix
  IN: [
    {
      business_name: 'PH Medicare LLP',
      address_1: '( ProHealth Asia Physiotherapy & Rehab Centre)',
      address_2: '1A, First Floor, Masjid Moth ; Opposite Neeti Bagh',
      city: 'New Delhi',
      post_code: '110049',
      contact_information: 'Phone: +91-11-42120200',
    },
  ],

  // PH: 1 clinic; contact_information is a bare number with no label (graceful fallback)
  PH: [
    {
      business_name: 'Pro-Health Asia-Philippines Inc',
      address_1: '2805-2807, 28th Floor, Centuria Medical Makati, Kalayaan Avenue cor.',
      address_2: 'Salamanca St., Poblacion',
      city: 'Makati City',
      post_code: '1210',
      contact_information: '(02) 7793 8762',
    },
  ],
};

// ─── buildGoogleMapsLink ──────────────────────────────────────────────────────

describe('buildGoogleMapsLink()', () => {
  test('produces a deterministic maps.google.com search URL', () => {
    const link = buildGoogleMapsLink('Clinic A', ['123 Main St', 'City 12345']);
    expect(link).toBe(buildGoogleMapsLink('Clinic A', ['123 Main St', 'City 12345']));
    expect(link).toMatch(/^https:\/\/maps\.google\.com\/\?q=/);
  });

  test('URL-encodes spaces and special characters', () => {
    const link = buildGoogleMapsLink('Clinic #1', ['Block 5, Jalan Besar']);
    expect(link).not.toMatch(/[ #,]/);
  });

  test('falls back to name-only when address parts are empty', () => {
    const link = buildGoogleMapsLink('Prohealth TBC', []);
    expect(link).toMatch(/^https:\/\/maps\.google\.com\/\?q=/);
    expect(link).toContain('Prohealth');
  });

  test('returns null when name and all address parts are empty/null', () => {
    expect(buildGoogleMapsLink('', [])).toBeNull();
    expect(buildGoogleMapsLink(null, [])).toBeNull();
    expect(buildGoogleMapsLink('', [null, undefined, ''])).toBeNull();
  });
});

// ─── extractPhone ─────────────────────────────────────────────────────────────

describe('extractPhone()', () => {
  test('SG: extracts Telephone: prefix', () => {
    expect(extractPhone('Telephone: +65 6533 0968\nWhatsApp: +65 9111 5623')).toBe('+65 6533 0968');
  });

  test('HK: extracts Phone: prefix', () => {
    expect(extractPhone('Phone: 25300073\nFax: 2530 2797')).toBe('25300073');
  });

  test('HK: extracts Tel: prefix', () => {
    expect(extractPhone('Tel: 25303022\nFax: 25305400')).toBe('25303022');
  });

  test('HK QB: extracts Phone: when Whatsapp: appears first', () => {
    expect(extractPhone('Whatsapp: 84001760\nPhone: 25300336\nFax: 25300068')).toBe('25300336');
  });

  test('IN: extracts Phone: prefix', () => {
    expect(extractPhone('Phone: +91-11-42120200')).toBe('+91-11-42120200');
  });

  test('PH: returns null when contact_information has no recognisable label', () => {
    expect(extractPhone('(02) 7793 8762')).toBeNull();
  });

  test('returns null when contact_information is null', () => {
    expect(extractPhone(null)).toBeNull();
  });
});

// ─── formatClinicForWhatsApp — per region ────────────────────────────────────

describe('formatClinicForWhatsApp() — SG', () => {
  const [clinic] = fixtures.SG;

  test('includes bold name, full address, phone, and map link', () => {
    const out = formatClinicForWhatsApp(clinic);
    expect(out).toContain('*Prohealth In Touch Physiotherapy*');
    expect(out).toContain('22 Malacca Street');
    expect(out).toContain('#14-02 RB Capital Building');
    expect(out).toContain('Singapore 048980');
    expect(out).toContain('📞 +65 6533 0968');
    expect(out).toContain('📍 https://maps.google.com/?q=');
  });

  test('does not expose raw fields or object dumps', () => {
    const out = formatClinicForWhatsApp(clinic);
    expect(out).not.toContain('{');
    expect(out).not.toContain('appointment_type_ids');
  });
});

describe('formatClinicForWhatsApp() — HK', () => {
  test('WS clinic: Phone: label extracted correctly', () => {
    const out = formatClinicForWhatsApp(fixtures.HK[0]);
    expect(out).toContain('*A. Prohealth Sports & Spinal Physiotherapy Centres (WS)*');
    expect(out).toContain('18F, One Silver Fortune Plaza');
    expect(out).toContain('📞 25300073');
    expect(out).toContain('📍 https://maps.google.com/?q=');
  });

  test('WWH clinic: Tel: label extracted correctly; null post_code omitted', () => {
    const out = formatClinicForWhatsApp(fixtures.HK[1]);
    expect(out).toContain('📞 25303022');
    expect(out).not.toContain('null');
  });

  test('TST clinic: Telephone: label extracted correctly', () => {
    const out = formatClinicForWhatsApp(fixtures.HK[2]);
    expect(out).toContain('📞 (852) 2666 5219');
  });

  test('QB clinic: Phone: extracted even when Whatsapp: appears first', () => {
    const out = formatClinicForWhatsApp(fixtures.HK[3]);
    expect(out).toContain('📞 25300336');
    expect(out).not.toContain('84001760'); // Whatsapp number not shown
  });

  test('empty string post_code treated as absent (city not followed by stray space or empty value)', () => {
    const out = formatClinicForWhatsApp(fixtures.HK[0]);
    expect(out).toContain('Central');
    expect(out).not.toContain('Central '); // no trailing space from empty post_code
    expect(out).not.toMatch(/Central,\s*$/m); // no trailing comma either
  });
});

describe('formatClinicForWhatsApp() — IN', () => {
  const [clinic] = fixtures.IN;

  test('shows name, both address fields, phone, and map link', () => {
    const out = formatClinicForWhatsApp(clinic);
    expect(out).toContain('*PH Medicare LLP*');
    expect(out).toContain('ProHealth Asia Physiotherapy');
    expect(out).toContain('1A, First Floor');
    expect(out).toContain('New Delhi 110049');
    expect(out).toContain('📞 +91-11-42120200');
    expect(out).toContain('📍 https://maps.google.com/?q=');
  });
});

describe('formatClinicForWhatsApp() — PH', () => {
  const [clinic] = fixtures.PH;

  test('shows name, address, map link; gracefully omits phone when no label present', () => {
    const out = formatClinicForWhatsApp(clinic);
    expect(out).toContain('*Pro-Health Asia-Philippines Inc*');
    expect(out).toContain('Centuria Medical Makati');
    expect(out).toContain('Makati City 1210');
    expect(out).toContain('📍 https://maps.google.com/?q=');
    expect(out).not.toContain('📞');
  });

  test('does not expose raw contact_information string as-is', () => {
    const out = formatClinicForWhatsApp(clinic);
    // The bare number should not appear as a top-level unlabelled line
    expect(out).not.toContain('\n(02) 7793 8762');
  });
});
