// CPV Code to Sector Mapping for Greek Procurement

export interface SectorPack {
  id: string;
  name: string;
  nameGr: string;
  cpvCodes: string[];
  keywords: string[];
  description: string;
}

export const SECTOR_PACKS: SectorPack[] = [
  {
    id: 'facilities',
    name: 'Facilities Management',
    nameGr: 'Διαχείριση Εγκαταστάσεων',
    cpvCodes: [
      '90910000', // Cleaning services
      '90911000', // Flat and window cleaning services
      '90919000', // Office cleaning services
      '77300000', // Garden and landscaping services
      '50800000', // Repair and maintenance services
    ],
    keywords: [
      'καθαρισμός',
      'συντήρηση',
      'φύλαξη',
      'κήπος',
      'υπηρεσίες καθαριότητας',
    ],
    description: 'Cleaning, maintenance, security, and landscaping services',
  },
  {
    id: 'security',
    name: 'Security Services',
    nameGr: 'Υπηρεσίες Ασφαλείας',
    cpvCodes: [
      '79700000', // Security services
      '79710000', // Security services
      '79711000', // Alarm-monitoring services
      '98341120', // Security services
    ],
    keywords: [
      'φύλαξη',
      'ασφάλεια',
      'φρουρά',
      'παρακολούθηση',
      'συναγερμός',
    ],
    description: 'Security, guard, and alarm monitoring services',
  },
  {
    id: 'ppe',
    name: 'PPE & Safety Equipment',
    nameGr: 'ΜΑΠ & Εξοπλισμός Ασφαλείας',
    cpvCodes: [
      '18100000', // Clothing
      '18110000', // Protective and safety clothing
      '18424000', // Safety headgear
      '35113400', // Safety equipment
      '33199000', // Protective equipment
    ],
    keywords: [
      'ΜΑΠ',
      'προστατευτικός εξοπλισμός',
      'γάντια',
      'κράνη',
      'ασφάλεια',
      'ρουχισμός',
    ],
    description: 'Personal protective equipment and safety gear',
  },
  {
    id: 'medical',
    name: 'Medical Consumables',
    nameGr: 'Ιατρικά Αναλώσιμα',
    cpvCodes: [
      '33140000', // Medical consumables
      '33141000', // Medical consumables
      '33600000', // Pharmaceutical products
      '33690000', // Various medicines
      '24400000', // Pharmaceutical products
    ],
    keywords: [
      'φάρμακα',
      'αναλώσιμα',
      'ιατρικά',
      'νοσοκομείο',
      'υγεία',
    ],
    description: 'Pharmaceuticals and medical consumables',
  },
  {
    id: 'medical-equipment',
    name: 'Medical Equipment',
    nameGr: 'Ιατρικός Εξοπλισμός',
    cpvCodes: [
      '33100000', // Medical equipment
      '33110000', // Medical equipment
      '33120000', // Diagnostic equipment
      '33190000', // Medical equipment
    ],
    keywords: [
      'ιατρικός εξοπλισμός',
      'διαγνωστικά',
      'νοσοκομείο',
      'απεικόνιση',
    ],
    description: 'Medical devices and diagnostic equipment',
  },
  {
    id: 'it-hardware',
    name: 'IT Hardware',
    nameGr: 'Εξοπλισμός Πληροφορικής',
    cpvCodes: [
      '30200000', // Computer equipment
      '30213000', // Personal computers
      '30231000', // Display screens
      '30236000', // Miscellaneous computer equipment
      '48000000', // Software package and information systems
    ],
    keywords: [
      'υπολογιστές',
      'servers',
      'οθόνες',
      'hardware',
      'πληροφορική',
    ],
    description: 'Computers, servers, and IT hardware',
  },
  {
    id: 'it-software',
    name: 'IT Software & Services',
    nameGr: 'Λογισμικό & Υπηρεσίες IT',
    cpvCodes: [
      '72000000', // IT services
      '72200000', // Software programming services
      '72400000', // Internet services
      '72500000', // Computer-related services
      '48000000', // Software packages
    ],
    keywords: [
      'λογισμικό',
      'ανάπτυξη',
      'προγραμματισμός',
      'cloud',
      'υπηρεσίες IT',
    ],
    description: 'Software development and IT services',
  },
  {
    id: 'construction',
    name: 'Construction',
    nameGr: 'Κατασκευές',
    cpvCodes: [
      '45000000', // Construction work
      '45100000', // Site preparation work
      '45200000', // Building construction work
      '45300000', // Building installation work
      '45400000', // Building completion work
    ],
    keywords: [
      'κατασκευή',
      'οικοδομικά',
      'έργα',
      'ανακαίνιση',
      'μελέτη',
    ],
    description: 'Construction and building works',
  },
  {
    id: 'consulting',
    name: 'Consulting Services',
    nameGr: 'Συμβουλευτικές Υπηρεσίες',
    cpvCodes: [
      '79400000', // Business and management consultancy services
      '79410000', // Business consultancy services
      '79420000', // Management-related services
      '71000000', // Architectural, engineering services
    ],
    keywords: [
      'συμβουλευτική',
      'μελέτη',
      'στρατηγική',
      'διοίκηση',
      'consulting',
    ],
    description: 'Business and management consulting',
  },
  {
    id: 'office-supplies',
    name: 'Office Supplies',
    nameGr: 'Γραφική Ύλη',
    cpvCodes: [
      '30190000', // Office equipment and supplies
      '30197000', // Office supplies
      '22800000', // Paper and paperboard
      '30100000', // Office machinery',
    ],
    keywords: [
      'γραφική ύλη',
      'χαρτί',
      'γραφείου',
      'αναλώσιμα',
      'εκτυπωτές',
    ],
    description: 'Office supplies and stationery',
  },
];

export function getSectorPackById(id: string): SectorPack | undefined {
  return SECTOR_PACKS.find(pack => pack.id === id);
}

export function getSectorPacksBySector(sectors: string[]): SectorPack[] {
  return SECTOR_PACKS.filter(pack => sectors.includes(pack.id));
}

export function getAllCPVCodesForSectors(sectors: string[]): string[] {
  const packs = getSectorPacksBySector(sectors);
  return packs.flatMap(pack => pack.cpvCodes);
}

export function getAllKeywordsForSectors(sectors: string[]): string[] {
  const packs = getSectorPacksBySector(sectors);
  return packs.flatMap(pack => pack.keywords);
}

export function getCPVDescription(cpvCode: string): string {
  // Simplified CPV descriptions
  const descriptions: Record<string, string> = {
    '90910000': 'Cleaning services',
    '79700000': 'Security services',
    '18110000': 'Protective and safety clothing',
    '33140000': 'Medical consumables',
    '33100000': 'Medical equipment',
    '30200000': 'Computer equipment',
    '72000000': 'IT services',
    '45000000': 'Construction work',
    '79400000': 'Business consultancy services',
    '30190000': 'Office equipment',
  };
  
  return descriptions[cpvCode] || 'Unknown CPV code';
}
