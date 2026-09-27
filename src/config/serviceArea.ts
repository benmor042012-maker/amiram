/**
 * Family Roofing's service area: Los Angeles and surrounding counties.
 * TO CONFIRM WITH AMIRAM: which counties/cities he actually wants.
 *
 * A lead is only treated as OUT_OF_AREA when we positively know it is outside
 * (ZIP or state). An unrecognized city stays UNKNOWN and is not penalized.
 */
export const serviceAreaConfig = {
  state: "CA",
  /** First three digits of ZIP codes we serve. */
  zipPrefixes: [
    // Los Angeles County
    "900", "901", "902", "903", "904", "905", "906", "907", "908",
    "910", "911", "912", "913", "914", "915", "916", "917", "918", "935",
    // Orange County
    "926", "927", "928",
    // Ventura County
    "930",
  ],
  /** Lower-case city / neighborhood names known to be in the area. */
  cities: [
    "los angeles", "la", "beverly hills", "west hollywood", "hollywood", "north hollywood",
    "santa monica", "venice", "culver city", "marina del rey", "playa del rey", "westwood",
    "brentwood", "bel air", "pacific palisades", "malibu", "encino", "sherman oaks",
    "studio city", "van nuys", "reseda", "tarzana", "woodland hills", "burbank", "glendale",
    "pasadena", "silver lake", "echo park", "los feliz", "inglewood", "hawthorne",
    "torrance", "manhattan beach", "hermosa beach", "redondo beach", "el segundo",
    "long beach", "downey", "whittier", "alhambra", "calabasas", "thousand oaks",
    "northridge", "granada hills", "valley village", "toluca lake", "mid-wilshire",
    "koreatown", "downtown los angeles", "dtla", "san fernando valley",
  ],
};
