import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Search, Filter, Star, Building2 } from "lucide-react";
import { formatCurrency, getDaysUntilDeadline, getDeadlineColor } from "@/lib/utils";

export default async function TendersPage({
  searchParams,
}: {
  searchParams: { q?: string; cpv?: string; region?: string };
}) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/login");
  }

  // Build search query
  const where: any = {
    status: "ACTIVE",
    deadline: {
      gte: new Date(),
    },
  };

  if (searchParams.q) {
    where.title = {
      contains: searchParams.q,
      mode: "insensitive",
    };
  }

  if (searchParams.cpv) {
    where.cpvCodes = {
      has: searchParams.cpv,
    };
  }

  if (searchParams.region) {
    where.region = searchParams.region;
  }

  // Fetch tenders
  const tenders = await prisma.tender.findMany({
    where,
    orderBy: {
      publicationDate: "desc",
    },
    take: 50,
  });

  // Check which tenders have bid rooms
  const bidRoomTenderIds = await prisma.bidRoom.findMany({
    where: {
      organizationId: session.user.organizationId,
      tenderId: {
        in: tenders.map((t) => t.id),
      },
    },
    select: {
      tenderId: true,
    },
  });

  const hasBidRoom = new Set(bidRoomTenderIds.map((br) => br.tenderId));

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
                <Button variant="default">Διαγωνισμοί</Button>
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
          <h1 className="text-3xl font-bold mb-2">Διαγωνισμοί</h1>
          <p className="text-gray-600">Ανακαλύψτε δημόσιους διαγωνισμούς που σας ταιριάζουν</p>
        </div>

        {/* Search & Filters */}
        <Card className="mb-6">
          <CardContent className="pt-6">
            <form method="get" className="flex gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                <Input
                  name="q"
                  placeholder="Αναζήτηση διαγωνισμών..."
                  className="pl-10"
                  defaultValue={searchParams.q}
                />
              </div>
              <Input
                name="cpv"
                placeholder="CPV Code"
                className="w-32"
                defaultValue={searchParams.cpv}
              />
              <Input
                name="region"
                placeholder="Περιφέρεια"
                className="w-40"
                defaultValue={searchParams.region}
              />
              <Button type="submit">
                <Filter className="h-4 w-4 mr-2" />
                Φίλτρα
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Results */}
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-gray-600">{tenders.length} διαγωνισμοί</p>
        </div>

        <div className="grid gap-4">
          {tenders.map((tender) => (
            <Card key={tender.id} className="hover:shadow-md transition-shadow">
              <CardContent className="pt-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <Link href={`/tenders/${tender.id}`}>
                      <h3 className="font-semibold text-lg hover:text-primary transition-colors cursor-pointer">
                        {tender.title}
                      </h3>
                    </Link>

                    <div className="flex items-center gap-4 mt-2 text-sm text-gray-600">
                      <span className="flex items-center gap-1">
                        <Building2 className="h-4 w-4" />
                        {tender.buyer}
                      </span>
                      {tender.region && <span>• {tender.region}</span>}
                      {tender.value && (
                        <span className="font-medium text-gray-900">
                          • {formatCurrency(tender.value)}
                        </span>
                      )}
                    </div>

                    {tender.cpvCodes && tender.cpvCodes.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-3">
                        {tender.cpvCodes.slice(0, 3).map((code) => (
                          <span
                            key={code}
                            className="px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded"
                          >
                            {code}
                          </span>
                        ))}
                        {tender.cpvCodes.length > 3 && (
                          <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">
                            +{tender.cpvCodes.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-3">
                    {tender.deadline && (
                      <div className="text-right">
                        <div className="text-xs text-gray-500">Λήξη</div>
                        <div className={`font-semibold ${getDeadlineColor(tender.deadline)}`}>
                          {getDaysUntilDeadline(tender.deadline)} ημέρες
                        </div>
                      </div>
                    )}

                    <div className="flex gap-2">
                      {hasBidRoom.has(tender.id) ? (
                        <Link href={`/bidrooms?tender=${tender.id}`}>
                          <Button size="sm" variant="outline">
                            Προβολή Bid Room
                          </Button>
                        </Link>
                      ) : (
                        <form action={`/api/bidrooms/create`} method="post">
                          <input type="hidden" name="tenderId" value={tender.id} />
                          <Button type="submit" size="sm">
                            Δημιουργία Bid Room
                          </Button>
                        </form>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          {tenders.length === 0 && (
            <Card>
              <CardContent className="py-16 text-center">
                <p className="text-gray-500">Δεν βρέθηκαν διαγωνισμοί</p>
                <p className="text-sm text-gray-400 mt-2">
                  Δοκιμάστε διαφορετικά κριτήρια αναζήτησης
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
