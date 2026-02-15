import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, FileText, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import Link from "next/link";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  // Get user's organization
  const membership = await prisma.membership.findFirst({
    where: { userId: session.user.id },
    include: { organization: true },
  });

  if (!membership) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>No Organization</CardTitle>
            <CardDescription>
              You need to be part of an organization to access the dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/onboarding">Complete Onboarding</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Get dashboard stats
  const [bidRooms, activeTenders, monitoringProfiles] = await Promise.all([
    prisma.bidRoom.findMany({
      where: { organizationId: membership.organizationId },
      include: { tender: true },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    }),
    prisma.tender.count({
      where: { status: 'active' },
    }),
    prisma.monitoringProfile.count({
      where: { organizationId: membership.organizationId },
    }),
  ]);

  const statusColors = {
    DRAFT: 'bg-gray-500',
    IN_REVIEW: 'bg-yellow-500',
    READY_TO_PACKAGE: 'bg-blue-500',
    READY_TO_SUBMIT: 'bg-green-500',
    SUBMITTED: 'bg-purple-500',
    ARCHIVED: 'bg-gray-400',
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
              <p className="text-gray-600 mt-1">Welcome back, {session.user.name}!</p>
            </div>
            <div className="flex gap-2">
              <Button asChild>
                <Link href="/tenders">Browse Tenders</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Bid Rooms</CardTitle>
              <Building2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{bidRooms.length}</div>
              <p className="text-xs text-muted-foreground">
                Across all tenders
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Tenders</CardTitle>
              <FileText className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{activeTenders}</div>
              <p className="text-xs text-muted-foreground">
                Available opportunities
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Monitoring Profiles</CardTitle>
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{monitoringProfiles}</div>
              <p className="text-xs text-muted-foreground">
                Active alert configurations
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Recent Bid Rooms */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Bid Rooms</CardTitle>
            <CardDescription>
              Your most recently updated bid rooms
            </CardDescription>
          </CardHeader>
          <CardContent>
            {bidRooms.length === 0 ? (
              <div className="text-center py-12">
                <Building2 className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-semibold text-gray-900">No bid rooms</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Get started by creating your first bid room.
                </p>
                <div className="mt-6">
                  <Button asChild>
                    <Link href="/tenders">Browse Tenders</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {bidRooms.map((bidRoom) => (
                  <Link
                    key={bidRoom.id}
                    href={`/bidrooms/${bidRoom.id}`}
                    className="block border rounded-lg p-4 hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <h3 className="font-semibold text-gray-900">{bidRoom.name}</h3>
                        <p className="text-sm text-gray-600 mt-1">{bidRoom.tender.title}</p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Deadline: {new Date(bidRoom.tender.deadline!).toLocaleDateString('el-GR')}
                          </span>
                          {bidRoom.tender.estimatedValue && (
                            <span>
                              Value: €{(bidRoom.tender.estimatedValue / 100).toLocaleString('el-GR')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div>
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium text-white ${
                            statusColors[bidRoom.status]
                          }`}
                        >
                          {bidRoom.status.replace(/_/g, ' ')}
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button asChild variant="outline" className="w-full justify-start">
                <Link href="/tenders">
                  <FileText className="mr-2 h-4 w-4" />
                  Browse All Tenders
                </Link>
              </Button>
              <Button asChild variant="outline" className="w-full justify-start">
                <Link href="/bidrooms">
                  <Building2 className="mr-2 h-4 w-4" />
                  View All Bid Rooms
                </Link>
              </Button>
              <Button asChild variant="outline" className="w-full justify-start">
                <Link href="/admin/templates">
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Manage Templates
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Getting Started</CardTitle>
              <CardDescription>
                New to BidRoom GR? Follow these steps
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="list-decimal list-inside space-y-2 text-sm text-gray-600">
                <li>Set up your monitoring profiles to match relevant tenders</li>
                <li>Browse available tenders and create bid rooms</li>
                <li>Upload documents and complete checklists</li>
                <li>Generate submission packages</li>
                <li>Submit through the NEPPS portal</li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
