import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.organizationId) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const formData = await request.formData();
    const tenderId = formData.get("tenderId") as string;

    if (!tenderId) {
      return NextResponse.json({ error: "Tender ID required" }, { status: 400 });
    }

    // Get tender details
    const tender = await prisma.tender.findUnique({
      where: { id: tenderId },
    });

    if (!tender) {
      return NextResponse.json({ error: "Tender not found" }, { status: 404 });
    }

    // Check if bid room already exists
    const existing = await prisma.bidRoom.findUnique({
      where: {
        organizationId_tenderId: {
          organizationId: session.user.organizationId,
          tenderId,
        },
      },
    });

    if (existing) {
      return NextResponse.redirect(new URL(`/bidrooms/${existing.id}`, request.url));
    }

    // Create bid room
    const bidRoom = await prisma.bidRoom.create({
      data: {
        organizationId: session.user.organizationId,
        tenderId,
        name: `Bid Room - ${tender.title}`,
        status: "DRAFT",
      },
    });

    // Create document slots
    await prisma.documentSlot.createMany({
      data: [
        { bidRoomId: bidRoom.id, category: "Eligibility", name: "Δικαιολογητικά Συμμετοχής", required: true, order: 1 },
        { bidRoomId: bidRoom.id, category: "Technical", name: "Τεχνική Προσφορά", required: true, order: 2 },
        { bidRoomId: bidRoom.id, category: "Financial", name: "Οικονομική Προσφορά", required: true, order: 3 },
        { bidRoomId: bidRoom.id, category: "Forms", name: "Έντυπα & Υπεύθυνες Δηλώσεις", required: true, order: 4 },
        { bidRoomId: bidRoom.id, category: "Annexes", name: "Παραρτήματα", required: false, order: 5 },
      ],
    });

    // Create audit event
    await prisma.auditEvent.create({
      data: {
        organizationId: session.user.organizationId,
        bidRoomId: bidRoom.id,
        userId: session.user.id,
        action: "BID_ROOM_CREATED",
        details: {
          tenderId: tender.id,
          tenderTitle: tender.title,
        },
      },
    });

    return NextResponse.redirect(new URL(`/bidrooms/${bidRoom.id}`, request.url));
  } catch (error: any) {
    console.error("Bid room creation error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
