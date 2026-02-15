import { NextRequest, NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";

export async function POST(request: NextRequest) {
  try {
    const { name, organizationName, email, password } = await request.json();

    // Validate input
    if (!name || !organizationName || !email || !password) {
      return NextResponse.json(
        { error: "All fields are required" },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "User already exists" },
        { status: 400 }
      );
    }

    // Hash password
    const hashedPassword = await hash(password, 12);

    // Create organization slug
    let slug = slugify(organizationName);
    let slugExists = await prisma.organization.findUnique({
      where: { slug },
    });

    // Make slug unique if needed
    let counter = 1;
    while (slugExists) {
      slug = `${slugify(organizationName)}-${counter}`;
      slugExists = await prisma.organization.findUnique({
        where: { slug },
      });
      counter++;
    }

    // Create organization and user in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create organization
      const organization = await tx.organization.create({
        data: {
          name: organizationName,
          slug,
          plan: "STARTER",
        },
      });

      // Create user
      const user = await tx.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
        },
      });

      // Create membership (make first user ORG_ADMIN)
      await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          role: "ORG_ADMIN",
        },
      });

      return { user, organization };
    });

    return NextResponse.json(
      {
        message: "User created successfully",
        userId: result.user.id,
        organizationId: result.organization.id,
      },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("Signup error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
