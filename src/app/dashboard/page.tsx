import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Briefcase, Clock, CheckCircle, Plus } from "lucide-react";
import { getDaysUntilDeadline, getDeadlineColor } from "@/lib/utils";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    redirect("/login");
  }

  // Fetch dashboard data
  const [tenderCount, activeBidRooms, recentTenders] = await Promise.all([
    prisma.tender.count({
      where: {
        status: "ACTIVE",
        deadline: {
          gte: new Date(),
        },
      },
    }),
    prisma.bidRoom.findMany({
      where: {
        organizationId: session.user.organizationId,
        status: {
          in: ["DRAFT", "IN_REVIEW", "READY_TO_PACKAGE", "READY_TO_SUBMIT"],
        },
      },
      include: {
        tender: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 5,
    }),
    prisma.tender.findMany({
      where: {
        status: "ACTIVE",
        deadline: {
          gte: new Date(),
        },
      },
      orderBy: {
        publicationDate: "desc",
      },
      take: 10,
    }),
  ]);

  const bidRoomsByStatus = {
    draft: activeBidRooms.filter((br) => br.status === "DRAFT").length,
    inReview: activeBidRooms.filter((br) => br.status === "IN_REVIEW").length,
    readyToSubmit: activeBidRooms.filter((br) => br.status === "READY_TO_SUBMIT").length,
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Navigation */}
      <nav className="bg-white border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="text-xl font-bold text-primary">
              BidRoom GR
            </Link>
            <div className="flex gap-4">
              <Link href="/dashboard">
                <Button variant="ghost">Dashboard</Button>
              </Link>
              <Link href="/tenders">
                <Button variant="ghost">Διαγωνισμοί</Button>
              </Link>
              <Link href="/bidrooms">
                <Button variant="ghost">Bid Rooms</Button>
              </Link>
              <Link href="/admin">
                <Button variant="ghost">Διαχείριση</Button>
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600">{session.user.name}</span>
            <Button variant="outline" size="sm" asChild>
              <Link href="/api/auth/signout">Έξοδος</Link>
            </Button>
          </div>
        </div>
      </nav>

      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Καλώς ήρθατε, {session.user.name}!</h1>
          <p className="text-gray-600">Επισκόπηση των διαγωνισμών και bid rooms σας</p>
        </div>

        {/* Stats Cards */}
        <div className="grid md:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Ενεργοί Διαγωνισμοί</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-primary" />
                <span className="text-3xl font-bold">{tenderCount}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Ενεργά Bid Rooms</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Briefcase className="h-5 w-5 text-primary" />
                <span className="text-3xl font-bold">{activeBidRooms.length}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Προς Αναθεώρηση</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-orange-500" />
                <span className="text-3xl font-bold">{bidRoomsByStatus.inReview}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Έτοιμα για Υποβολή</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-500" />
                <span className="text-3xl font-bold">{bidRoomsByStatus.readyToSubmit}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Active Bid Rooms */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Ενεργά Bid Rooms</CardTitle>
                <Link href="/bidrooms">
                  <Button size="sm">Προβολή Όλων</Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {activeBidRooms.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <p>Δεν υπάρχουν ενεργά bid rooms</p>
                  <Link href="/tenders">
                    <Button className="mt-4" size="sm">
                      <Plus className="h-4 w-4 mr-2" />
                      Δημιουργία Bid Room
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="space-y-3">
                  {activeBidRooms.map((bidRoom) => (
                    <Link key={bidRoom.id} href={`/bidrooms/${bidRoom.id}`}>
                      <div className="p-4 border rounded-lg hover:border-primary transition-colors cursor-pointer">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <h3 className="font-semibold">{bidRoom.tender.title}</h3>
                            <p className="text-sm text-gray-600 mt-1">
                              {bidRoom.tender.buyer}
                            </p>
                            <div className="flex items-center gap-2 mt-2">
                              <span
                                className={`text-xs px-2 py-1 rounded-full ${
                                  bidRoom.status === "DRAFT"
                                    ? "bg-gray-100 text-gray-700"
                                    : bidRoom.status === "IN_REVIEW"
                                    ? "bg-orange-100 text-orange-700"
                                    : "bg-green-100 text-green-700"
                                }`}
                              >
                                {bidRoom.status}
                              </span>
                              {bidRoom.tender.deadline && (
                                <span
                                  className={`text-xs ${getDeadlineColor(
                                    bidRoom.tender.deadline
                                  )}`}
                                >
                                  {getDaysUntilDeadline(bidRoom.tender.deadline)} ημέρες
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Tenders */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Πρόσφατοι Διαγωνισμοί</CardTitle>
                <Link href="/tenders">
                  <Button size="sm">Προβολή Όλων</Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {recentTenders.slice(0, 5).map((tender) => (
                  <Link key={tender.id} href={`/tenders/${tender.id}`}>
                    <div className="p-4 border rounded-lg hover:border-primary transition-colors cursor-pointer">
                      <h3 className="font-semibold line-clamp-2">{tender.title}</h3>
                      <p className="text-sm text-gray-600 mt-1">{tender.buyer}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                        {tender.value && <span>€{tender.value.toLocaleString()}</span>}
                        {tender.deadline && (
                          <span className={getDeadlineColor(tender.deadline)}>
                            Λήξη: {new Date(tender.deadline).toLocaleDateString("el-GR")}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
