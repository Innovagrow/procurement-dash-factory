import { PrismaAdapter } from "@auth/prisma-adapter";
import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { prisma } from "./prisma";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error("Invalid credentials");
        }

        const user = await prisma.user.findUnique({
          where: {
            email: credentials.email,
          },
          include: {
            memberships: {
              include: {
                organization: true,
              },
            },
          },
        });

        if (!user || !user.password) {
          throw new Error("Invalid credentials");
        }

        const isPasswordValid = await compare(credentials.password, user.password);

        if (!isPasswordValid) {
          throw new Error("Invalid credentials");
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, account }) {
      if (user) {
        token.id = user.id;
        
        // Get user's organization and role
        const membership = await prisma.membership.findFirst({
          where: { userId: user.id },
          include: { organization: true },
        });

        if (membership) {
          token.organizationId = membership.organizationId;
          token.organizationSlug = membership.organization.slug;
          token.role = membership.role;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.organizationId = token.organizationId as string;
        session.user.organizationSlug = token.organizationSlug as string;
        session.user.role = token.role as string;
      }
      return session;
    },
  },
};

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberships: {
        include: {
          organization: true,
        },
      },
    },
  });

  return user;
}

export async function hasPermission(userId: string, organizationId: string, requiredRole: string[]) {
  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      organizationId,
    },
  });

  if (!membership) return false;

  const roleHierarchy: Record<string, number> = {
    VIEWER: 1,
    CONTRIBUTOR: 2,
    BID_MANAGER: 3,
    ORG_ADMIN: 4,
  };

  const userRoleLevel = roleHierarchy[membership.role] || 0;
  const minRequiredLevel = Math.min(...requiredRole.map(role => roleHierarchy[role] || 999));

  return userRoleLevel >= minRequiredLevel;
}
