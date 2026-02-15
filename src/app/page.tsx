import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Building2, FileCheck, Package, Rocket, Search, Shield } from "lucide-react";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white">
      {/* Navigation */}
      <nav className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 className="h-6 w-6 text-primary" />
            <span className="text-xl font-bold">BidRoom GR</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login">
              <Button variant="ghost">Σύνδεση</Button>
            </Link>
            <Link href="/signup">
              <Button>Εγγραφή</Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20 text-center">
        <h1 className="text-5xl font-bold mb-6 bg-gradient-to-r from-blue-600 to-blue-400 bg-clip-text text-transparent">
          Η Πλατφόρμα για Δημόσιους Διαγωνισμούς
        </h1>
        <p className="text-xl text-gray-600 mb-8 max-w-2xl mx-auto">
          Ανακαλύψτε, προετοιμάστε και υποβάλετε προσφορές για δημόσιους διαγωνισμούς στην Ελλάδα με επαγγελματικό τρόπο.
        </p>
        <div className="flex gap-4 justify-center">
          <Link href="/signup">
            <Button size="lg" className="text-lg">
              Ξεκινήστε Δωρεάν
              <Rocket className="ml-2 h-5 w-5" />
            </Button>
          </Link>
          <Link href="/login">
            <Button size="lg" variant="outline" className="text-lg">
              Σύνδεση
            </Button>
          </Link>
        </div>

        {/* Stats */}
        <div className="grid md:grid-cols-3 gap-8 mt-16 max-w-3xl mx-auto">
          <div className="text-center">
            <div className="text-3xl font-bold text-primary">30,000+</div>
            <div className="text-gray-600">Διαγωνισμοί ετησίως</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-primary">€10B+</div>
            <div className="text-gray-600">Προϋπολογισμός</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-primary">100%</div>
            <div className="text-gray-600">Ελληνικές πηγές</div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="container mx-auto px-4 py-20">
        <h2 className="text-3xl font-bold text-center mb-12">Χαρακτηριστικά</h2>
        <div className="grid md:grid-cols-3 gap-8">
          <Card>
            <CardHeader>
              <Search className="h-10 w-10 text-primary mb-2" />
              <CardTitle>Ανακάλυψη Διαγωνισμών</CardTitle>
              <CardDescription>
                Βρείτε σχετικούς διαγωνισμούς χωρίς να γνωρίζετε κωδικούς CPV. Απλά επιλέξτε τον τομέα σας.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <FileCheck className="h-10 w-10 text-primary mb-2" />
              <CardTitle>Bid Room</CardTitle>
              <CardDescription>
                Διαχειριστείτε έγγραφα, checklist, εργασίες και υπογραφές σε ένα χώρο εργασίας.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <Package className="h-10 w-10 text-primary mb-2" />
              <CardTitle>Συσκευασία</CardTitle>
              <CardDescription>
                Αυτόματη δημιουργία ZIP με σωστή δομή, ονοματολογία και manifest για υποβολή.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <Shield className="h-10 w-10 text-primary mb-2" />
              <CardTitle>Compliance</CardTitle>
              <CardDescription>
                Έλεγχοι πληρότητας, υποχρεωτικών εγγράφων και υπογραφών πριν την υποβολή.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <Rocket className="h-10 w-10 text-primary mb-2" />
              <CardTitle>Submission Assistant</CardTitle>
              <CardDescription>
                Βήμα-βήμα οδηγός για υποβολή στο NEPPS/ESIDIS με validations και αποδείξεις.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <Building2 className="h-10 w-10 text-primary mb-2" />
              <CardTitle>Multi-Tenancy</CardTitle>
              <CardDescription>
                Διαχείριση πολλών οργανισμών, ρόλων και χρηστών σε μία πλατφόρμα.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>

      {/* Data Sources */}
      <section className="container mx-auto px-4 py-20">
        <h2 className="text-3xl font-bold text-center mb-12">Πηγές Δεδομένων</h2>
        <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle>KHMDHS/KIMDIS</CardTitle>
              <CardDescription>
                30,000+ ελληνικοί διαγωνισμοί ετησίως
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Diavgeia</CardTitle>
              <CardDescription>
                2M+ αποφάσεις δημόσιου τομέα
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>TED (EU)</CardTitle>
              <CardDescription>
                Ευρωπαϊκοί διαγωνισμοί (προαιρετικό)
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>

      {/* CTA */}
      <section className="container mx-auto px-4 py-20 text-center">
        <Card className="max-w-2xl mx-auto bg-gradient-to-r from-blue-600 to-blue-400 text-white border-0">
          <CardHeader>
            <CardTitle className="text-3xl text-white">Ξεκινήστε Σήμερα</CardTitle>
            <CardDescription className="text-blue-100 text-lg">
              Δημιουργήστε δωρεάν λογαριασμό και ανακαλύψτε διαγωνισμούς που σας ταιριάζουν.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/signup">
              <Button size="lg" variant="secondary" className="text-lg">
                Δωρεάν Εγγραφή
                <Rocket className="ml-2 h-5 w-5" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      </section>

      {/* Footer */}
      <footer className="border-t bg-gray-50 py-8">
        <div className="container mx-auto px-4 text-center text-gray-600">
          <p>&copy; 2026 BidRoom GR. Όλα τα δικαιώματα κατοχυρωμένα.</p>
          <p className="mt-2 text-sm">
            Επίσημη πηγή: KHMDHS/KIMDIS OpenData API, Diavgeia API
          </p>
        </div>
      </footer>
    </div>
  );
}
