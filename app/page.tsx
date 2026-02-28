"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const checkUser = async () => {
      const { data } = await supabase.auth.getUser();
      
      if (!data.user) {
        // Not logged in, send to signup
        router.push("/signup");
        return;
      }

      // Get their role
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("role")
        .eq("user_id", data.user.id)
        .single();

      if (profile) {
        if (profile.role === "club") {
          router.push("/submit-trial");
        } else {
          router.push("/trials");
        }
      }
    };
    checkUser();
  }, [router]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-12 text-center">
      <p>Loading...</p>
    </div>
  );
}
