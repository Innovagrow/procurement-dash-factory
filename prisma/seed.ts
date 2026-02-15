import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create demo organization
  const org = await prisma.organization.upsert({
    where: { slug: 'demo-org' },
    update: {},
    create: {
      name: 'Demo Organization',
      slug: 'demo-org',
      plan: 'STARTER',
    },
  });

  console.log('✅ Created organization:', org.name);

  // Create demo users
  const hashedPassword = await hash('password123', 12);

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@demo.gr' },
    update: {},
    create: {
      email: 'admin@demo.gr',
      name: 'Διαχειριστής Demo',
      password: hashedPassword,
    },
  });

  const managerUser = await prisma.user.upsert({
    where: { email: 'manager@demo.gr' },
    update: {},
    create: {
      email: 'manager@demo.gr',
      name: 'Manager Demo',
      password: hashedPassword,
    },
  });

  const contributorUser = await prisma.user.upsert({
    where: { email: 'contributor@demo.gr' },
    update: {},
    create: {
      email: 'contributor@demo.gr',
      name: 'Contributor Demo',
      password: hashedPassword,
    },
  });

  console.log('✅ Created users');

  // Create memberships
  await prisma.membership.upsert({
    where: {
      userId_organizationId: {
        userId: adminUser.id,
        organizationId: org.id,
      },
    },
    update: {},
    create: {
      userId: adminUser.id,
      organizationId: org.id,
      role: 'ORG_ADMIN',
    },
  });

  await prisma.membership.upsert({
    where: {
      userId_organizationId: {
        userId: managerUser.id,
        organizationId: org.id,
      },
    },
    update: {},
    create: {
      userId: managerUser.id,
      organizationId: org.id,
      role: 'BID_MANAGER',
    },
  });

  await prisma.membership.upsert({
    where: {
      userId_organizationId: {
        userId: contributorUser.id,
        organizationId: org.id,
      },
    },
    update: {},
    create: {
      userId: contributorUser.id,
      organizationId: org.id,
      role: 'CONTRIBUTOR',
    },
  });

  console.log('✅ Created memberships');

  // Create monitoring profiles
  const facilitiesProfile = await prisma.monitoringProfile.create({
    data: {
      organizationId: org.id,
      name: 'Facilities & Cleaning',
      sectors: ['facilities', 'security'],
      regions: ['Αττική', 'Κεντρική Μακεδονία'],
      minBudget: 10000,
      maxBudget: 500000,
      certifications: ['ISO 9001'],
      isActive: true,
      cpvCodes: {
        create: [
          { cpvCode: '90910000', cpvName: 'Cleaning services' },
          { cpvCode: '79700000', cpvName: 'Security services' },
        ],
      },
      keywords: {
        create: [
          { keyword: 'καθαρισμός' },
          { keyword: 'φύλαξη' },
          { keyword: 'ασφάλεια' },
        ],
      },
    },
  });

  const ppeProfile = await prisma.monitoringProfile.create({
    data: {
      organizationId: org.id,
      name: 'PPE & Safety Equipment',
      sectors: ['ppe'],
      regions: ['Αττική'],
      minBudget: 5000,
      maxBudget: 200000,
      isActive: true,
      cpvCodes: {
        create: [
          { cpvCode: '18110000', cpvName: 'Protective and safety clothing' },
          { cpvCode: '35113400', cpvName: 'Safety equipment' },
        ],
      },
      keywords: {
        create: [
          { keyword: 'ΜΑΠ' },
          { keyword: 'προστατευτικός εξοπλισμός' },
        ],
      },
    },
  });

  console.log('✅ Created monitoring profiles');

  // Create sample tenders
  const now = new Date();
  const tenders = [];

  for (let i = 1; i <= 20; i++) {
    const deadline = new Date(now);
    deadline.setDate(now.getDate() + Math.floor(Math.random() * 60) + 10);

    const publicationDate = new Date(now);
    publicationDate.setDate(now.getDate() - Math.floor(Math.random() * 30));

    const tender = await prisma.tender.create({
      data: {
        source: 'KIMDIS',
        externalId: `DEMO-${i.toString().padStart(5, '0')}`,
        title: [
          'Προμήθεια υπηρεσιών καθαρισμού κτιρίων',
          'Υπηρεσίες φύλαξης',
          'Προμήθεια ΜΑΠ',
          'Συντήρηση κλιματιστικών',
          'Προμήθεια γραφικής ύλης',
          'Υπηρεσίες πληροφορικής',
          'Ανακαίνιση κτιρίου',
          'Προμήθεια ιατρικών αναλωσίμων',
          'Υπηρεσίες καθαριότητας νοσοκομείου',
          'Προμήθεια εξοπλισμού ασφαλείας',
        ][i % 10],
        description: `Περιγραφή διαγωνισμού ${i}. Αναλυτικές προδιαγραφές στα τεύχη του διαγωνισμού.`,
        buyer: [
          'Δήμος Αθηναίων',
          'Περιφέρεια Αττικής',
          'Γενικό Νοσοκομείο Αθηνών',
          'Υπουργείο Υγείας',
          'Δήμος Θεσσαλονίκης',
        ][i % 5],
        buyerAddress: 'Ελλάδα',
        cpvCodes: ['90910000', '79700000', '18110000'],
        sectors: ['facilities', 'security', 'ppe'],
        value: Math.floor(Math.random() * 400000) + 10000,
        currency: 'EUR',
        publicationDate,
        deadline,
        country: 'GR',
        region: ['Αττική', 'Κεντρική Μακεδονία'][i % 2],
        portalLink: 'https://nepps-search.eprocurement.gov.gr/',
        status: 'ACTIVE',
      },
    });

    tenders.push(tender);
  }

  console.log('✅ Created 20 sample tenders');

  // Create 2 sample bid rooms
  const bidRoom1 = await prisma.bidRoom.create({
    data: {
      organizationId: org.id,
      tenderId: tenders[0].id,
      name: 'Bid Room - ' + tenders[0].title,
      status: 'DRAFT',
    },
  });

  const bidRoom2 = await prisma.bidRoom.create({
    data: {
      organizationId: org.id,
      tenderId: tenders[1].id,
      name: 'Bid Room - ' + tenders[1].title,
      status: 'IN_REVIEW',
    },
  });

  console.log('✅ Created 2 sample bid rooms');

  // Create sample checklist items
  await prisma.checklistItem.createMany({
    data: [
      {
        bidRoomId: bidRoom1.id,
        title: 'Έλεγχος προϋποθέσεων συμμετοχής',
        required: true,
        order: 1,
      },
      {
        bidRoomId: bidRoom1.id,
        title: 'Προετοιμασία τεχνικής προσφοράς',
        required: true,
        order: 2,
      },
      {
        bidRoomId: bidRoom1.id,
        title: 'Προετοιμασία οικονομικής προσφοράς',
        required: true,
        order: 3,
      },
    ],
  });

  console.log('✅ Created sample checklist items');

  // Create sample checklist templates
  const facilitiesTemplate = await prisma.checklistTemplate.create({
    data: {
      organizationId: org.id,
      name: 'Facilities Management Template',
      sector: 'Facilities',
      items: {
        create: [
          {
            title: 'Άδεια λειτουργίας εταιρείας',
            description: 'Έλεγχος και επισύναψη άδειας λειτουργίας',
            required: true,
            order: 1,
          },
          {
            title: 'Πιστοποιητικό ISO 9001',
            description: 'Πιστοποιητικό ποιότητας',
            required: true,
            order: 2,
          },
          {
            title: 'Τεχνική προσφορά',
            description: 'Αναλυτική τεχνική προσφορά',
            required: true,
            order: 3,
          },
          {
            title: 'Οικονομική προσφορά',
            description: 'Σφραγισμένη οικονομική προσφορά',
            required: true,
            order: 4,
          },
        ],
      },
    },
  });

  console.log('✅ Created checklist templates');

  console.log('🎉 Seeding completed successfully!');
  console.log('\nDemo credentials:');
  console.log('Admin: admin@demo.gr / password123');
  console.log('Manager: manager@demo.gr / password123');
  console.log('Contributor: contributor@demo.gr / password123');
}

main()
  .catch((e) => {
    console.error('❌ Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
