// CPV Code mappings to sectors and descriptions
// This is a curated list of common Greek public procurement sectors

export const SECTOR_PACKS = {
  Facilities: {
    name: 'Facilities & Maintenance',
    cpvCodes: [
      { code: '45000000', name: 'Construction work' },
      { code: '45100000', name: 'Site preparation work' },
      { code: '45200000', name: 'Works for complete or part construction' },
      { code: '45300000', name: 'Building installation work' },
      { code: '45400000', name: 'Building completion work' },
      { code: '50000000', name: 'Repair and maintenance services' },
      { code: '50700000', name: 'Repair and maintenance services of building installations' },
      { code: '77300000', name: 'Gardening services' },
      { code: '90600000', name: 'Cleaning and sanitation services' },
      { code: '90900000', name: 'Cleaning and sanitation services in urban or rural areas' },
    ],
    keywords: ['maintenance', 'cleaning', 'facilities', 'building', 'repair', 'gardening'],
  },
  Security: {
    name: 'Security Services',
    cpvCodes: [
      { code: '79700000', name: 'Investigation and security services' },
      { code: '79710000', name: 'Security services' },
      { code: '79711000', name: 'Alarm-monitoring services' },
      { code: '79715000', name: 'Patrol services' },
      { code: '35000000', name: 'Security, fire-fighting, police and defence equipment' },
      { code: '35100000', name: 'Emergency and security equipment' },
    ],
    keywords: ['security', 'guard', 'surveillance', 'patrol', 'alarm', 'safety'],
  },
  PPE: {
    name: 'Personal Protective Equipment',
    cpvCodes: [
      { code: '18100000', name: 'Protective and safety clothing' },
      { code: '18110000', name: 'Protective headgear' },
      { code: '18140000', name: 'Protective and safety equipment' },
      { code: '18141000', name: 'Protective and safety equipment' },
      { code: '18424300', name: 'Protective and safety footwear' },
      { code: '33140000', name: 'Medical consumables' },
    ],
    keywords: ['protective', 'PPE', 'safety equipment', 'masks', 'gloves', 'helmets'],
  },
  Medical: {
    name: 'Medical Consumables & Equipment',
    cpvCodes: [
      { code: '33000000', name: 'Medical equipments, pharmaceuticals and personal care products' },
      { code: '33100000', name: 'Medical equipments' },
      { code: '33140000', name: 'Medical consumables' },
      { code: '33600000', name: 'Pharmaceutical products' },
      { code: '33690000', name: 'Miscellaneous medical and pharmaceutical products' },
      { code: '85100000', name: 'Health services' },
    ],
    keywords: ['medical', 'pharmaceutical', 'healthcare', 'hospital', 'diagnostic', 'consumables'],
  },
  IT: {
    name: 'IT & Software',
    cpvCodes: [
      { code: '48000000', name: 'Software package and information systems' },
      { code: '48800000', name: 'Information systems and servers' },
      { code: '72000000', name: 'IT services: consulting, software development' },
      { code: '72200000', name: 'Software programming and consultancy services' },
      { code: '72260000', name: 'Software-related services' },
      { code: '72400000', name: 'Internet services' },
      { code: '30200000', name: 'Computer equipment and supplies' },
    ],
    keywords: ['software', 'IT', 'cloud', 'systems', 'cybersecurity', 'digital'],
  },
  Consulting: {
    name: 'Consulting & Professional Services',
    cpvCodes: [
      { code: '71000000', name: 'Architectural, construction, engineering services' },
      { code: '71200000', name: 'Architectural and related services' },
      { code: '71300000', name: 'Engineering services' },
      { code: '79400000', name: 'Business and management consultancy services' },
      { code: '79410000', name: 'Business and management consultancy services' },
      { code: '79420000', name: 'Management-related services' },
      { code: '79800000', name: 'Printing and related services' },
    ],
    keywords: ['consulting', 'advisory', 'management', 'engineering', 'architectural'],
  },
  Transport: {
    name: 'Transport & Logistics',
    cpvCodes: [
      { code: '60000000', name: 'Transport services' },
      { code: '60100000', name: 'Road transport services' },
      { code: '60400000', name: 'Air transport services' },
      { code: '60600000', name: 'Transport services' },
      { code: '63000000', name: 'Supporting and auxiliary transport services' },
      { code: '63100000', name: 'Cargo handling and storage services' },
    ],
    keywords: ['transport', 'logistics', 'freight', 'cargo', 'delivery', 'shipping'],
  },
  Catering: {
    name: 'Catering & Food Services',
    cpvCodes: [
      { code: '15000000', name: 'Food, beverages, tobacco' },
      { code: '15800000', name: 'Miscellaneous food products' },
      { code: '55000000', name: 'Hotel, restaurant and retail trade services' },
      { code: '55300000', name: 'Restaurant and food-serving services' },
      { code: '55500000', name: 'Canteen and catering services' },
    ],
    keywords: ['catering', 'food', 'restaurant', 'canteen', 'meals', 'hospitality'],
  },
}

export const GREEK_REGIONS = [
  'Αττική (Attica)',
  'Κεντρική Μακεδονία (Central Macedonia)',
  'Κρήτη (Crete)',
  'Ανατολική Μακεδονία και Θράκη (Eastern Macedonia and Thrace)',
  'Ήπειρος (Epirus)',
  'Θεσσαλία (Thessaly)',
  'Ιόνια Νησιά (Ionian Islands)',
  'Βόρειο Αιγαίο (North Aegean)',
  'Πελοπόννησος (Peloponnese)',
  'Νότιο Αιγαίο (South Aegean)',
  'Δυτική Ελλάδα (Western Greece)',
  'Δυτική Μακεδονία (Western Macedonia)',
  'Στερεά Ελλάδα (Central Greece)',
]

export function getCPVPackBySector(sector: string) {
  return SECTOR_PACKS[sector as keyof typeof SECTOR_PACKS] || null
}

export function getAllSectors() {
  return Object.keys(SECTOR_PACKS)
}

export function getSectorKeywords(sector: string): string[] {
  const pack = getCPVPackBySector(sector)
  return pack?.keywords || []
}
