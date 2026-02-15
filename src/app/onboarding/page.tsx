import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Rocket } from "lucide-react";

export default async function OnboardingPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader className="text-center">
          <Rocket className="mx-auto h-12 w-12 text-primary mb-2" />
          <CardTitle className="text-2xl">Welcome to BidRoom GR!</CardTitle>
          <CardDescription>
            Let's set up your tender monitoring preferences
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12">
            <h3 className="text-sm font-semibold text-gray-900">
              Onboarding Wizard
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              This feature is under development. You'll be able to set up your sector preferences, regions, and budget ranges here.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
