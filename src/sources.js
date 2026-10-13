// Official source pages — the ONLY data origin for this app.
//
// Ali's original plan: fetch show listings directly from these official
// platform pages (no Google, no news sites). Each entry is a category /
// channel / language listing page on the platform itself.
//
// Fields: name (display label), url, language, channel.
// Entries flagged unverified:true are best-guess URLs for the text-only
// items Ali listed ("Zee TV", "Zee5 Web Series", "hotstar Originals",
// "Sony Liv Originals") — confirm/correct them if extraction fails.

export const SOURCES = {
  JioHotstar: [
    { name: 'StarPlus', url: 'https://www.hotstar.com/in/browse/category/starplus/821', language: 'Hindi', channel: 'StarPlus' },
    { name: 'Colors Hindi', url: 'https://www.hotstar.com/in/browse/category/colors-hindi/1271341270', language: 'Hindi', channel: 'Colors' },
    { name: 'Star Vijay', url: 'https://www.hotstar.com/in/browse/category/star-vijay/824', language: 'Tamil', channel: 'Star Vijay' },
    { name: 'Star Maa', url: 'https://www.hotstar.com/in/browse/category/star-maa/4300', language: 'Telugu', channel: 'Star Maa' },
    { name: 'Star Pravah', url: 'https://www.hotstar.com/in/browse/category/star-pravah/819', language: 'Marathi', channel: 'Star Pravah' },
    { name: 'Star Jalsha', url: 'https://www.hotstar.com/in/browse/category/star-jalsha/817', language: 'Bengali', channel: 'Star Jalsha' },
    { name: 'Star Bharat', url: 'https://www.hotstar.com/in/browse/category/star-bharat/15016', language: 'Hindi', channel: 'Star Bharat' },
    { name: 'Colors Marathi', url: 'https://www.hotstar.com/in/browse/category/colors-marathi/1271341273', language: 'Marathi', channel: 'Colors Marathi' },
    { name: 'Colors Bangla', url: 'https://www.hotstar.com/in/browse/category/colors-bangla/1271341267', language: 'Bengali', channel: 'Colors Bangla' },
    // Verified 2026-10-13: official "Hotstar Specials" category page
    // (JioHotstar originals — matches the /browse/category/<slug>/<id> pattern
    // of the other Hotstar sources; indexed titles: The Court, Batchmates…).
    { name: 'Hotstar Specials', url: 'https://www.hotstar.com/in/browse/category/hotstar-specials/1260003991', language: 'Hindi', channel: 'Hotstar Specials' }
  ],
  ZEE5: [
    { name: '&TV Shows', url: 'https://www.zee5.com/collections/andtv-shows/0-8-manualcollection_106858385', language: 'Hindi', channel: '&TV' },
    { name: 'ZEE5 Marathi', url: 'https://www.zee5.com/tv-shows/lang/marathi', language: 'Marathi', channel: 'ZEE5' },
    { name: 'ZEE5 Kannada', url: 'https://www.zee5.com/tv-shows/lang/kannada', language: 'Kannada', channel: 'ZEE5' },
    { name: 'Zee Bangla', url: 'https://www.zee5.com/tv-shows/zee-bangla-hd/0-9-zeebangla', language: 'Bengali', channel: 'Zee Bangla' },
    { name: 'ZEE5 Tamil', url: 'https://www.zee5.com/tv-shows/lang/tamil', language: 'Tamil', channel: 'ZEE5' },
    { name: 'ZEE5 Telugu', url: 'https://www.zee5.com/tv-shows/lang/telugu', language: 'Telugu', channel: 'ZEE5' },
    // Verified 2026-10-13: official "ZEE TV Shows" collection page (lists Lakshmi
    // Nivas, Saru, Vasudha, Kumkum Bhagya…).
    { name: 'Zee TV', url: 'https://www.zee5.com/collections/zee-tv-shows/0-8-manualcoll_126442496', language: 'Hindi', channel: 'Zee TV' },
    // Verified 2026-10-13: "ZEE5 Originals Home Page" (lists Mithya, Gyaarah
    // Gyaarah, Murshid, Sunflower…).
    { name: 'ZEE5 Web Series', url: 'https://www.zee5.com/web-series', language: '', channel: 'ZEE5' }
  ],
  SonyLIV: [
    { name: 'Sony SAB', url: 'https://www.sonyliv.com/custompage/sony-sab-463', language: 'Hindi', channel: 'Sony SAB' },
    { name: 'Sony Entertainment Television', url: 'https://www.sonyliv.com/custompage/sony-entertainment-television-506', language: 'Hindi', channel: 'Sony TV' },
    // Verified 2026-10-13: official "Watch Specials Online" listing page
    // (lists Gullak, Undekhi, Scam 1992, Maharani, Scam 2003…).
    { name: 'SonyLIV Originals', url: 'https://www.sonyliv.com/listing/specials-1111_9012481', language: 'Hindi', channel: 'SonyLIV' }
  ],
  'Sun NXT': [
    // The /live/ channel pages from the original list don't expose extractable
    // listings ("Error fetching content"), so we use the official TV-shows
    // catalogue page instead.
    { name: 'Sun NXT TV Shows', url: 'https://www.sunnxt.com/tv-shows', language: '', channel: 'Sun NXT' }
  ]
};

export function allSources() {
  const out = [];
  for (const [platform, list] of Object.entries(SOURCES)) {
    for (const s of list) out.push({ platform, ...s });
  }
  return out;
}

export function sourceCount() {
  return allSources().length;
}
