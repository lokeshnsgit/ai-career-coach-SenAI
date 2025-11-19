"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { GoogleGenAI } from "@google/genai"; // NEW SDK

// Initialize Gemini client
const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Model instance
const model = genAI.models;

// ---------------------------------------------------------
// Generate Cover Letter
// ---------------------------------------------------------
export async function generateCoverLetter(data) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  const prompt = `
    Write a professional cover letter for a ${data.jobTitle} position at ${
    data.companyName
  }.
    
    About the candidate:
    - Industry: ${user.industry}
    - Years of Experience: ${user.experience}
    - Skills: ${user.skills?.join(", ")}
    - Professional Background: ${user.bio}
    
    Job Description:
    ${data.jobDescription}
    
    Requirements:
    1. Use a professional, enthusiastic tone
    2. Highlight relevant skills and experience
    3. Show understanding of the company's needs
    4. Keep it concise (max 400 words)
    5. Use proper business letter formatting in markdown
    6. Include specific examples of achievements
    7. Relate candidate's background to job requirements
    
    Format the letter in markdown.
  `;

  try {
    // New SDK request format with resilience for quota errors.
    // Try the preferred model first, then fall back to a lower-tier model
    // if we hit quota limits (RESOURCE_EXHAUSTED / 429).
  const preferredModel = "gemini-2.5-pro";
    const fallbackModel = "gemini-2.0-flash";

    const parseRetryMs = (err) => {
      try {
        const msg = typeof err?.message === "string" ? err.message : null;
        const parsed = msg && msg.trim().startsWith("{") ? JSON.parse(msg) : null;
        const details = parsed?.error?.details || [];
        for (const d of details) {
          if (d['@type'] && d['@type'].includes('RetryInfo') && d.retryDelay) {
            // retryDelay like "42s" or "42.854797884s"
            const m = /([0-9]+(?:\.[0-9]+)?)s/.exec(d.retryDelay);
            if (m) return Math.ceil(parseFloat(m[1]) * 1000);
          }
        }
      } catch (e) {
        // ignore parse errors
      }
      return 0;
    };

    const isQuotaError = (err) => {
      if (!err) return false;
      if (err?.status === 429) return true;
      const msg = typeof err?.message === "string" ? err.message : JSON.stringify(err);
      if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded')) return true;
      try {
        const parsed = msg && msg.trim().startsWith("{") ? JSON.parse(msg) : null;
        if (parsed?.error?.code === 429) return true;
        if (parsed?.error?.status === 'RESOURCE_EXHAUSTED') return true;
      } catch (e) {
        // ignore
      }
      return false;
    };

    const attemptGenerate = async (modelName) => {
      return await model.generateContent({ model: modelName, contents: prompt });
    };

    let result;
    try {
      result = await attemptGenerate(preferredModel);
    } catch (err) {
      if (isQuotaError(err)) {
        const waitMs = parseRetryMs(err);
        console.warn(`Quota hit for ${preferredModel}. Waiting ${waitMs}ms (if provided) then trying fallback model ${fallbackModel}.`, err?.message ?? err);
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        // Try fallback once
        try {
          result = await attemptGenerate(fallbackModel);
        } catch (err2) {
          // If fallback also fails, surface original/second error for debugging
          console.error(`Both preferred model (${preferredModel}) and fallback model (${fallbackModel}) failed.`, err2?.message ?? err2);
          throw err2;
        }
      } else {
        // Not a quota issue — rethrow to be handled by outer catch
        throw err;
      }
    }

    // Normalize possible response shapes from the SDK so we reliably extract text.
    // Newer @google/genai exposes a `text` getter on the response; some older
    // integrations may return `response.text` or a `response.candidates` structure.
    let content;
    try {
      if (typeof result?.text === "string") {
        content = result.text.trim();
      } else if (typeof result?.response?.text === "string") {
        content = result.response.text.trim();
      } else if (
        result?.response?.candidates?.[0]?.content?.parts &&
        Array.isArray(result.response.candidates[0].content.parts)
      ) {
        content = result.response.candidates[0].content.parts
          .map((p) => p.text || "")
          .join("")
          .trim();
      } else {
        // Helpful debug when the response shape is unexpected.
        console.error("Unexpected GenAI response shape:", result);
        throw new Error("AI returned no text");
      }
    } catch (e) {
      console.error("Error extracting text from GenAI response:", e, result);
      throw new Error("Failed to parse AI response");
    }

    const coverLetter = await db.coverLetter.create({
      data: {
        content,
        jobDescription: data.jobDescription,
        companyName: data.companyName,
        jobTitle: data.jobTitle,
        status: "completed",
        userId: user.id,
      },
    });

    return coverLetter;
  } catch (error) {
    console.error("Error generating cover letter:", error);
    throw new Error("Failed to generate cover letter");
  }
}

// ---------------------------------------------------------
// Get all cover letters
// ---------------------------------------------------------
export async function getCoverLetters() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  return await db.coverLetter.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
}

// ---------------------------------------------------------
// Get single cover letter
// ---------------------------------------------------------
export async function getCoverLetter(id) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  return await db.coverLetter.findUnique({
    where: { id, userId: user.id },
  });
}

// ---------------------------------------------------------
// Delete cover letter
// ---------------------------------------------------------
export async function deleteCoverLetter(id) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  return await db.coverLetter.delete({
    where: { id, userId: user.id },
  });
}
