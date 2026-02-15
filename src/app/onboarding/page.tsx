"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { Building2, CheckCircle2, Loader2 } from "lucide-react";
import { SECTOR_PACKS } from "@/lib/cpv-sectors";

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [selectedSectors, setSelectedSectors] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [minBudget, setMinBudget] = useState("");
  const [maxBudget, setMaxBudget] = useState("");
  const [certifications, setCertifications] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { data: session } = useSession();
  const { toast } = useToast();

  const greekRegions = [
    "Αττική",
    "Κεντρική Μακεδονία",
    "Δυτική Ελλάδα",
    "Κρήτη",
    "Θεσσαλία",
    "Ανατολική Μακεδονία και Θράκη",
    "Πελοπόννησος",
    "Δυτική Μακεδονία",
    "Ήπειρος",
    "Ιόνια Νησιά",
    "Βόρειο Αιγαίο",
    "Νότιο Αιγαίο",
    "Στερεά Ελλάδα",
  ];

  const toggleSector = (sectorId: string) => {
    setSelectedSectors((prev) =>
      prev.includes(sectorId) ? prev.filter((s) => s !== sectorId) : [...prev, sectorId]
    );
  };

  const toggleRegion = (region: string) => {
    setRegions((prev) => (prev.includes(region) ? prev.filter((r) => r !== region) : [...prev, region]));
  };

  const handleComplete = async () => {
    if (selectedSectors.length === 0) {
      toast({
        title: "Επιλέξτε τουλάχιστον έναν τομέα",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/monitoring-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Αρχικό Προφίλ Παρακολούθησης",
          sectors: selectedSectors,
          regions: regions.length > 0 ? regions : greekRegions, // Default to all if none selected
          minBudget: minBudget ? parseFloat(minBudget) : null,
          maxBudget: maxBudget ? parseFloat(maxBudget) : null,
          certifications: certifications.split(",").map((c) => c.trim()).filter(Boolean),
          exclusions: exclusions.split(",").map((e) => e.trim()).filter(Boolean),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to create monitoring profile");
      }

      toast({
        title: "Επιτυχία!",
        description: "Το προφίλ παρακολούθησης δημιουργήθηκε",
      });

      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      toast({
        title: "Σφάλμα",
        description: "Κάτι πήγε στραβά. Παρακαλώ δοκιμάστε ξανά.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-white py-12 px-4">
      <div className="container mx-auto max-w-4xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="p-3 bg-primary/10 rounded-full">
              <Building2 className="h-10 w-10 text-primary" />
            </div>
          </div>
          <h1 className="text-3xl font-bold mb-2">Καλώς ήρθατε στο BidRoom GR!</h1>
          <p className="text-gray-600">Ας ρυθμίσουμε το προφίλ σας για να βρούμε σχετικούς διαγωνισμούς</p>
        </div>

        {/* Progress */}
        <div className="flex items-center justify-center mb-8 gap-2">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`h-2 w-24 rounded-full ${
                s <= step ? "bg-primary" : "bg-gray-200"
              }`}
            />
          ))}
        </div>

        {/* Step 1: Sectors */}
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Σε ποιους τομείς δραστηριοποιείστε;</CardTitle>
              <CardDescription>
                Επιλέξτε τους τομείς που σας ενδιαφέρουν (δεν χρειάζεται να γνωρίζετε CPV codes)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4">
                {SECTOR_PACKS.map((sector) => (
                  <button
                    key={sector.id}
                    onClick={() => toggleSector(sector.id)}
                    className={`p-4 border-2 rounded-lg text-left transition-all ${
                      selectedSectors.includes(sector.id)
                        ? "border-primary bg-primary/5"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="font-semibold">{sector.nameGr}</h3>
                        <p className="text-sm text-gray-600 mt-1">{sector.description}</p>
                      </div>
                      {selectedSectors.includes(sector.id) && (
                        <CheckCircle2 className="h-5 w-5 text-primary flex-shrink-0 ml-2" />
                      )}
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex justify-end mt-6">
                <Button onClick={() => setStep(2)} disabled={selectedSectors.length === 0}>
                  Επόμενο
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 2: Regions & Budget */}
        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Γεωγραφική κάλυψη και προϋπολογισμός</CardTitle>
              <CardDescription>Προσαρμόστε τα κριτήρια αναζήτησης</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <Label className="text-base mb-3 block">Περιφέρειες</Label>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {greekRegions.map((region) => (
                    <button
                      key={region}
                      onClick={() => toggleRegion(region)}
                      className={`px-3 py-2 text-sm rounded-md border transition-all ${
                        regions.includes(region)
                          ? "border-primary bg-primary text-white"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      {region}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  {regions.length === 0 ? "Όλες οι περιφέρειες (προεπιλογή)" : `${regions.length} επιλεγμένες`}
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="minBudget">Ελάχιστος προϋπολογισμός (€)</Label>
                  <Input
                    id="minBudget"
                    type="number"
                    placeholder="π.χ. 10000"
                    value={minBudget}
                    onChange={(e) => setMinBudget(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="maxBudget">Μέγιστος προϋπολογισμός (€)</Label>
                  <Input
                    id="maxBudget"
                    type="number"
                    placeholder="π.χ. 500000"
                    value={maxBudget}
                    onChange={(e) => setMaxBudget(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex gap-4 justify-between mt-6">
                <Button variant="outline" onClick={() => setStep(1)}>
                  Πίσω
                </Button>
                <Button onClick={() => setStep(3)}>Επόμενο</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Certifications & Exclusions */}
        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle>Πιστοποιήσεις και εξαιρέσεις</CardTitle>
              <CardDescription>Τελικές προσαρμογές (προαιρετικό)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <Label htmlFor="certifications">Πιστοποιήσεις / Άδειες</Label>
                <Input
                  id="certifications"
                  placeholder="π.χ. ISO 9001, ISO 27001 (διαχωρισμός με κόμμα)"
                  value={certifications}
                  onChange={(e) => setCertifications(e.target.value)}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Διαχωρίστε πολλαπλές πιστοποιήσεις με κόμμα
                </p>
              </div>

              <div>
                <Label htmlFor="exclusions">Λέξεις-κλειδιά εξαίρεσης</Label>
                <Input
                  id="exclusions"
                  placeholder="π.χ. άμυνα, στρατιωτικά (διαχωρισμός με κόμμα)"
                  value={exclusions}
                  onChange={(e) => setExclusions(e.target.value)}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Διαγωνισμοί που περιέχουν αυτές τις λέξεις θα αποκλείονται
                </p>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h4 className="font-semibold mb-2">Επιλεγμένοι τομείς:</h4>
                <div className="flex flex-wrap gap-2">
                  {selectedSectors.map((sectorId) => {
                    const sector = SECTOR_PACKS.find((s) => s.id === sectorId);
                    return (
                      <span key={sectorId} className="px-3 py-1 bg-white rounded-full text-sm">
                        {sector?.nameGr}
                      </span>
                    );
                  })}
                </div>
              </div>

              <div className="flex gap-4 justify-between mt-6">
                <Button variant="outline" onClick={() => setStep(2)}>
                  Πίσω
                </Button>
                <Button onClick={handleComplete} disabled={loading}>
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Αποθήκευση...
                    </>
                  ) : (
                    "Ολοκλήρωση"
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
