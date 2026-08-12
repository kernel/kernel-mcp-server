import { OAuthConsent, RedirectToSignIn, Show } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Col } from "@/components/col";
import { KernelWordmark } from "@/components/icons";

export const metadata: Metadata = {
  title: "authorize access | Kernel",
  referrer: "strict-origin-when-cross-origin",
};

export default function OAuthConsentPage(): React.ReactElement {
  return (
    <Show when="signed-in" fallback={<RedirectToSignIn />}>
      <Col className="min-h-screen items-center justify-center p-8">
        <Col className="w-full max-w-md items-center gap-8">
          <KernelWordmark className="text-foreground" width={100} height={22} />
          <OAuthConsent
            appearance={{
              elements: {
                rootBox: "w-full",
                cardBox: "w-full",
                card: "w-full",
              },
            }}
            fallback={
              <p className="text-sm text-muted-foreground">
                loading authorization...
              </p>
            }
          />
        </Col>
      </Col>
    </Show>
  );
}
