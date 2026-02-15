import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAllCPVCodesForSectors, getAllKeywordsForSectors } from "@/lib/cpv-sectors";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.organizationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name, sectors, regions, minBudget, maxBudget, certifications, exclusions } = await request.json();

    if (!name || !sectors || sectors.length === 0) {
      return NextResponse.json({ error: "Name and sectors are required" }, { status: 400 });
    }

    // Get CPV codes and keywords for selected sectors
    const cpvCodes = getAllCPVCodesForSectors(sectors);
    const keywords = getAllKeywordsForSectors(sectors);

    // Create monitoring profile
    const profile = await prisma.monitoringProfile.create({
      data: {
        organizationId: session.user.organizationId,
        name,
        sectors,
        regions,
        minBudget,
        maxBudget,
        certifications,
        isActive: true,
        cpvCodes: {
          create: cpvCodes.map((code) => ({ cpvCode: code })),
        },
        keywords: {
          create: keywords.map((keyword) => ({ keyword })),
        },
        exclusions: {
          create: exclusions.map((value: string) => ({
            exclusionType: "keyword",
            exclusionValue: value,
          })),
        },
      },
    });

    return NextResponse.json({ success: true, profileId: profile.id }, { status: 201 });
  } catch (error: any) {
    console.error("Monitoring profile creation error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
