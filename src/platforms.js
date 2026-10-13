// Platform + channel configuration for the Indian TV Release Monitor.
// Channels are grouped by their parent OTT platform so the researcher can
// cover a whole platform in a single grounded search call.

export const PLATFORMS = [
  {
    name: 'JioHotstar',
    channels: [
      { name: 'Star Plus', language: 'Hindi', url: 'https://www.hotstar.com/in/browse/category/starplus/821' },
      { name: 'Colors Hindi', language: 'Hindi', url: 'https://www.hotstar.com/in/browse/category/colors-hindi/1271341270' },
      { name: 'Star Vijay', language: 'Tamil', url: 'https://www.hotstar.com/in/browse/category/star-vijay/824' },
      { name: 'Star Maa', language: 'Telugu', url: 'https://www.hotstar.com/in/browse/category/star-maa/4300' },
      { name: 'Star Pravah', language: 'Marathi', url: 'https://www.hotstar.com/in/browse/category/star-pravah/819' },
      { name: 'Star Jalsha', language: 'Bengali', url: 'https://www.hotstar.com/in/browse/category/star-jalsha/817' },
      { name: 'Star Bharat', language: 'Hindi', url: 'https://www.hotstar.com/in/browse/category/star-bharat/15016' },
      { name: 'Colors Marathi', language: 'Marathi', url: 'https://www.hotstar.com/in/browse/category/colors-marathi/1271341273' },
      { name: 'Colors Bangla', language: 'Bengali', url: 'https://www.hotstar.com/in/browse/category/colors-bangla/1271341267' },
      { name: 'Hotstar Originals', language: 'Hindi', url: 'https://www.hotstar.com/in' },
      { name: 'Hotstar Web Series', language: 'Hindi', url: 'https://www.hotstar.com/in' }
    ]
  },
  {
    name: 'ZEE5',
    channels: [
      { name: 'Zee TV', language: 'Hindi', url: 'https://www.zee5.com/tv-shows/lang/hindi' },
      { name: '&TV', language: 'Hindi', url: 'https://www.zee5.com/collections/andtv-shows/0-8-manualcollection_106858385' },
      { name: 'Zee Marathi', language: 'Marathi', url: 'https://www.zee5.com/tv-shows/lang/marathi' },
      { name: 'Zee Kannada', language: 'Kannada', url: 'https://www.zee5.com/tv-shows/lang/kannada' },
      { name: 'Zee Bangla', language: 'Bengali', url: 'https://www.zee5.com/tv-shows/zee-bangla-hd/0-9-zeebangla' },
      { name: 'Zee Tamil', language: 'Tamil', url: 'https://www.zee5.com/tv-shows/lang/tamil' },
      { name: 'Zee Telugu', language: 'Telugu', url: 'https://www.zee5.com/tv-shows/lang/telugu' },
      { name: 'ZEE5 Originals', language: 'Hindi', url: 'https://www.zee5.com/' },
      { name: 'ZEE5 Web Series', language: 'Hindi', url: 'https://www.zee5.com/' }
    ]
  },
  {
    name: 'SonyLIV',
    channels: [
      { name: 'Sony SAB', language: 'Hindi', url: 'https://www.sonyliv.com/custompage/sony-sab-463' },
      { name: 'Sony Entertainment Television', language: 'Hindi', url: 'https://www.sonyliv.com/custompage/sony-entertainment-television-506' },
      { name: 'SonyLIV Originals', language: 'Hindi', url: 'https://www.sonyliv.com/' },
      { name: 'SonyLIV Web Series', language: 'Hindi', url: 'https://www.sonyliv.com/' }
    ]
  },
  {
    name: 'Sun NXT',
    channels: [
      { name: 'Sun Bangla', language: 'Bengali', url: 'https://www.sunnxt.com/live/sun-bangla-bengali-live/194388/sun-bangla' },
      { name: 'Sun Neo', language: 'Hindi', url: 'https://www.sunnxt.com/live/sun-neo-hd-hindi-live/194389/sun-neo-hd' },
      { name: 'Sun NXT Originals', language: 'Tamil', url: 'https://www.sunnxt.com/' }
    ]
  }
];

// Flat lists used to build the filter dropdowns in the UI.
export function platformNames() {
  return PLATFORMS.map((p) => p.name);
}

export function channelNames() {
  return PLATFORMS.flatMap((p) => p.channels.map((c) => c.name));
}

export function languageNames() {
  const set = new Set();
  for (const p of PLATFORMS) for (const c of p.channels) set.add(c.language);
  return [...set].sort();
}
