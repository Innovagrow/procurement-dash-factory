import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Starting database seed...')

  // Clean existing data
  console.log('Cleaning existing data...')
  await prisma.auditEvent.deleteMany()
  await prisma.submissionProof.deleteMany()
  await prisma.package.deleteMany()
  await prisma.comment.deleteMany()
  await prisma.task.deleteMany()
  await prisma.checklistItem.deleteMany()
  await prisma.documentVersion.deleteMany()
  await prisma.documentSlot.deleteMany()
  await prisma.bidRoom.deleteMany()
  await prisma.watchlist.deleteMany()
  await prisma.savedSearch.deleteMany()
  await prisma.tenderAttachmentLink.deleteMany()
  await prisma.tenderRevision.deleteMany()
  await prisma.tender.deleteMany()
  await prisma.profileExclusion.deleteMany()
  await prisma.profileKeyword.deleteMany()
  await prisma.profileCPV.deleteMany()
  await prisma.monitoringProfile.deleteMany()
  await prisma.checklistTemplateItem.deleteMany()
  await prisma.checklistTemplate.deleteMany()
  await prisma.membership.deleteMany()
  await prisma.account.deleteMany()
  await prisma.session.deleteMany()
  await prisma.user.deleteMany()
  await prisma.organization.deleteMany()

  // Create demo organization
  console.log('Creating demo organization...')
  const demoOrg = await prisma.organization.create({
    data: {
      name: 'Demo Company Ltd',
      slug: 'demo-company',
      plan: 'GROWTH',
    },
  })

  // Create users
  console.log('Creating demo users...')
  const hashedPassword = await bcrypt.hash('password123', 12)

  const adminUser = await prisma.user.create({
    data: {
      name: 'Admin User',
      email: 'admin@demo.com',
      password: hashedPassword,
    },
  })

  const managerUser = await prisma.user.create({
    data: {
      name: 'Bid Manager',
      email: 'manager@demo.com',
      password: hashedPassword,
    },
  })

  const contributorUser = await prisma.user.create({
    data: {
      name: 'Contributor User',
      email: 'contributor@demo.com',
      password: hashedPassword,
    },
  })

  // Create memberships
  console.log('Creating memberships...')
  await prisma.membership.create({
    data: {
      userId: adminUser.id,
      organizationId: demoOrg.id,
      role: 'ORG_ADMIN',
    },
  })

  await prisma.membership.create({
    data: {
      userId: managerUser.id,
      organizationId: demoOrg.id,
      role: 'BID_MANAGER',
    },
  })

  await prisma.membership.create({
    data: {
      userId: contributorUser.id,
      organizationId: demoOrg.id,
      role: 'CONTRIBUTOR',
    },
  })

  // Create monitoring profiles
  console.log('Creating monitoring profiles...')
  const facilitiesProfile = await prisma.monitoringProfile.create({
    data: {
      organizationId: demoOrg.id,
      name: 'Facilities & Maintenance',
      sectors: ['Facilities'],
      regions: ['Αττική (Attica)', 'Κεντρική Μακεδονία (Central Macedonia)'],
      budgetMin: 10000 * 100, // €10,000
      budgetMax: 500000 * 100, // €500,000
      certifications: ['ISO 9001', 'ISO 14001'],
    },
  })

  await prisma.profileCPV.createMany({
    data: [
      { profileId: facilitiesProfile.id, cpvCode: '45000000', cpvName: 'Construction work' },
      { profileId: facilitiesProfile.id, cpvCode: '50000000', cpvName: 'Repair and maintenance services' },
      { profileId: facilitiesProfile.id, cpvCode: '90600000', cpvName: 'Cleaning and sanitation services' },
    ],
  })

  await prisma.profileKeyword.createMany({
    data: [
      { profileId: facilitiesProfile.id, keyword: 'maintenance' },
      { profileId: facilitiesProfile.id, keyword: 'cleaning' },
      { profileId: facilitiesProfile.id, keyword: 'facilities' },
      { profileId: facilitiesProfile.id, keyword: 'building' },
    ],
  })

  const ppeProfile = await prisma.monitoringProfile.create({
    data: {
      organizationId: demoOrg.id,
      name: 'PPE & Safety Equipment',
      sectors: ['PPE'],
      regions: ['Αττική (Attica)'],
      budgetMin: 5000 * 100,
      budgetMax: 200000 * 100,
      certifications: ['CE Marking', 'ISO 9001'],
    },
  })

  await prisma.profileCPV.createMany({
    data: [
      { profileId: ppeProfile.id, cpvCode: '18100000', cpvName: 'Protective and safety clothing' },
      { profileId: ppeProfile.id, cpvCode: '18140000', cpvName: 'Protective and safety equipment' },
    ],
  })

  // Create sample tenders
  console.log('Creating sample tenders...')
  const tenders = await Promise.all([
    prisma.tender.create({
      data: {
        tenderCode: 'GR-2026-001234',
        title: 'Υπηρεσίες καθαρισμού δημόσιων κτιρίων Αθήνας',
        description: 'Προμήθεια υπηρεσιών καθαρισμού για δημόσια κτίρια στην περιοχή της Αθήνας για διάρκεια 24 μηνών.',
        source: 'KIMDIS',
        sourceUrl: 'https://www.eprocurement.gov.gr/tender/GR-2026-001234',
        cpvCodes: ['90600000', '90900000'],
        sectors: ['Facilities'],
        buyerName: 'Δήμος Αθηναίων',
        buyerRegion: 'Αττική (Attica)',
        estimatedValue: 250000 * 100, // €250,000
        currency: 'EUR',
        publicationDate: new Date('2026-02-01'),
        deadline: new Date('2026-03-15'),
        status: 'active',
      },
    }),
    prisma.tender.create({
      data: {
        tenderCode: 'GR-2026-001567',
        title: 'Προμήθεια Μέσων Ατομικής Προστασίας',
        description: 'Προμήθεια ΜΑΠ για το προσωπικό νοσοκομείου, συμπεριλαμβανομένων μασκών, γαντιών, και προστατευτικών ενδυμάτων.',
        source: 'KIMDIS',
        sourceUrl: 'https://www.eprocurement.gov.gr/tender/GR-2026-001567',
        cpvCodes: ['18100000', '18140000', '33140000'],
        sectors: ['PPE', 'Medical'],
        buyerName: 'Γενικό Νοσοκομείο Αθηνών',
        buyerRegion: 'Αττική (Attica)',
        estimatedValue: 150000 * 100,
        currency: 'EUR',
        publicationDate: new Date('2026-02-05'),
        deadline: new Date('2026-03-20'),
        status: 'active',
      },
    }),
    prisma.tender.create({
      data: {
        tenderCode: 'GR-2026-002001',
        title: 'Συντήρηση και επισκευή σχολικών κτιρίων',
        description: 'Εργασίες συντήρησης, επισκευής και βελτίωσης σχολικών κτιρίων στην περιοχή Θεσσαλονίκης.',
        source: 'KIMDIS',
        sourceUrl: 'https://www.eprocurement.gov.gr/tender/GR-2026-002001',
        cpvCodes: ['45000000', '45400000', '50700000'],
        sectors: ['Facilities'],
        buyerName: 'Περιφέρεια Κεντρικής Μακεδονίας',
        buyerRegion: 'Κεντρική Μακεδονία (Central Macedonia)',
        estimatedValue: 450000 * 100,
        currency: 'EUR',
        publicationDate: new Date('2026-01-28'),
        deadline: new Date('2026-03-10'),
        status: 'active',
      },
    }),
  ])

  // Create checklist templates
  console.log('Creating checklist templates...')
  const facilitiesTemplate = await prisma.checklistTemplate.create({
    data: {
      organizationId: demoOrg.id,
      name: 'Facilities & Maintenance Checklist',
      sector: 'Facilities',
      description: 'Standard checklist for facilities management tenders',
    },
  })

  await prisma.checklistTemplateItem.createMany({
    data: [
      {
        templateId: facilitiesTemplate.id,
        title: 'Company Registration Certificate',
        description: 'Valid company registration from business registry',
        isMandatory: true,
        order: 1,
      },
      {
        templateId: facilitiesTemplate.id,
        title: 'Tax Clearance Certificate',
        description: 'Recent tax clearance certificate (within 30 days)',
        isMandatory: true,
        order: 2,
      },
      {
        templateId: facilitiesTemplate.id,
        title: 'Insurance Certificates',
        description: 'Professional liability and general liability insurance',
        isMandatory: true,
        order: 3,
      },
      {
        templateId: facilitiesTemplate.id,
        title: 'ISO 9001 Certificate',
        description: 'Quality management system certification',
        isMandatory: false,
        order: 4,
      },
      {
        templateId: facilitiesTemplate.id,
        title: 'Company Portfolio',
        description: 'Examples of previous similar projects',
        isMandatory: false,
        order: 5,
      },
      {
        templateId: facilitiesTemplate.id,
        title: 'Staff CVs',
        description: 'CVs of key personnel to be assigned',
        isMandatory: true,
        order: 6,
      },
      {
        templateId: facilitiesTemplate.id,
        title: 'Financial Offer',
        description: 'Detailed pricing breakdown',
        isMandatory: true,
        order: 7,
      },
      {
        templateId: facilitiesTemplate.id,
        title: 'Technical Specifications Response',
        description: 'Response to all technical requirements',
        isMandatory: true,
        order: 8,
      },
    ],
  })

  // Create sample bid rooms
  console.log('Creating sample bid rooms...')
  const bidRoom1 = await prisma.bidRoom.create({
    data: {
      organizationId: demoOrg.id,
      tenderId: tenders[0].id,
      name: 'Athens Cleaning Services Bid',
      status: 'DRAFT',
    },
  })

  const bidRoom2 = await prisma.bidRoom.create({
    data: {
      organizationId: demoOrg.id,
      tenderId: tenders[1].id,
      name: 'PPE Hospital Supply Bid',
      status: 'IN_REVIEW',
    },
  })

  // Create document slots for bid room 1
  console.log('Creating document slots...')
  await prisma.documentSlot.createMany({
    data: [
      {
        bidRoomId: bidRoom1.id,
        slotType: 'ELIGIBILITY',
        name: 'Company Registration',
        isMandatory: true,
        requiresSignature: false,
      },
      {
        bidRoomId: bidRoom1.id,
        slotType: 'ELIGIBILITY',
        name: 'Tax Clearance',
        isMandatory: true,
        requiresSignature: true,
        signatureType: 'QES',
      },
      {
        bidRoomId: bidRoom1.id,
        slotType: 'TECHNICAL',
        name: 'Technical Specifications',
        isMandatory: true,
        requiresSignature: false,
      },
      {
        bidRoomId: bidRoom1.id,
        slotType: 'FINANCIAL',
        name: 'Financial Offer',
        isMandatory: true,
        requiresSignature: true,
        signatureType: 'ADES',
      },
    ],
  })

  // Create checklist items from template
  const templateItems = await prisma.checklistTemplateItem.findMany({
    where: { templateId: facilitiesTemplate.id },
    orderBy: { order: 'asc' },
  })

  await prisma.checklistItem.createMany({
    data: templateItems.map((item) => ({
      bidRoomId: bidRoom1.id,
      title: item.title,
      description: item.description,
      isMandatory: item.isMandatory,
      isCompleted: false,
      order: item.order,
    })),
  })

  // Create sample tasks
  console.log('Creating sample tasks...')
  await prisma.task.createMany({
    data: [
      {
        bidRoomId: bidRoom1.id,
        title: 'Prepare technical specifications document',
        description: 'Draft complete response to technical requirements',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        dueDate: new Date('2026-03-05'),
        assignedToId: contributorUser.id,
        createdById: managerUser.id,
      },
      {
        bidRoomId: bidRoom1.id,
        title: 'Obtain tax clearance certificate',
        description: 'Visit tax office to get recent clearance certificate',
        status: 'TODO',
        priority: 'URGENT',
        dueDate: new Date('2026-03-01'),
        assignedToId: adminUser.id,
        createdById: managerUser.id,
      },
      {
        bidRoomId: bidRoom1.id,
        title: 'Review financial calculations',
        description: 'Double-check all pricing and cost calculations',
        status: 'TODO',
        priority: 'MEDIUM',
        dueDate: new Date('2026-03-08'),
        assignedToId: managerUser.id,
        createdById: managerUser.id,
      },
    ],
  })

  // Create audit events
  console.log('Creating audit events...')
  await prisma.auditEvent.createMany({
    data: [
      {
        organizationId: demoOrg.id,
        bidRoomId: bidRoom1.id,
        userId: managerUser.id,
        action: 'created_bid_room',
        entityType: 'BidRoom',
        entityId: bidRoom1.id,
        metadata: { name: 'Athens Cleaning Services Bid' },
      },
      {
        organizationId: demoOrg.id,
        bidRoomId: bidRoom2.id,
        userId: managerUser.id,
        action: 'created_bid_room',
        entityType: 'BidRoom',
        entityId: bidRoom2.id,
        metadata: { name: 'PPE Hospital Supply Bid' },
      },
    ],
  })

  console.log('✅ Seed completed successfully!')
  console.log('\n📊 Summary:')
  console.log(`  - Organizations: 1`)
  console.log(`  - Users: 3`)
  console.log(`  - Monitoring Profiles: 2`)
  console.log(`  - Tenders: ${tenders.length}`)
  console.log(`  - Bid Rooms: 2`)
  console.log(`  - Checklist Templates: 1`)
  console.log('\n🔑 Demo Login Credentials:')
  console.log('  Email: admin@demo.com')
  console.log('  Password: password123')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
