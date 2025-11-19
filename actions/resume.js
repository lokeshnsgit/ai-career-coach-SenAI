"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { GoogleGenAI } from "@google/genai";
import { revalidatePath } from "next/cache";

// ✅ Updated Gemini SDK (new GenAI client)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = ai.models;

export async function saveResume(content) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  try {
    const resume = await db.resume.upsert({
      where: {
        userId: user.id,
      },
      update: {
        content,
      },
      create: {
        userId: user.id,
        content,
      },
    });

    revalidatePath("/resume");
    return resume;
  } catch (error) {
    console.error("Error saving resume:", error);
    throw new Error("Failed to save resume");
  }
}

export async function getResume() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  return await db.resume.findUnique({
    where: {
      userId: user.id,
    },
  });
}

export async function improveWithAI({ current, type }) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    include: {
      industryInsight: true,
    },
  });

  if (!user) throw new Error("User not found");

  const prompt = `
    As an expert resume writer, improve the following ${type} description for a ${user.industry} professional.
    Make it more impactful, quantifiable, and aligned with industry standards.
    Current content: "${current}"

    Requirements:
    1. Use action verbs
    2. Include metrics and results where possible
    3. Highlight relevant technical skills
    4. Keep it concise but detailed
    5. Focus on achievements over responsibilities
    6. Use industry-specific keywords
    
    Format the response as a single paragraph without any additional text or explanations.
  `;

  try {
    // ✅ New GenAI call using the SDK model wrapper
    const result = await model.generateContent({
  model: "gemini-2.5-pro",
      contents: prompt,
    });

    // Normalize response shapes
    let improvedContent;
    if (typeof result?.text === "string") {
      improvedContent = result.text.trim();
    } else if (typeof result?.response?.text === "string") {
      improvedContent = result.response.text.trim();
    } else if (
      result?.response?.candidates?.[0]?.content?.parts &&
      Array.isArray(result.response.candidates[0].content.parts)
    ) {
      improvedContent = result.response.candidates[0].content.parts
        .map((p) => p.text || "")
        .join("")
        .trim();
    } else {
      console.error("Unexpected GenAI response shape:", result);
      throw new Error("AI returned no text");
    }

    return improvedContent;
  } catch (error) {
    console.error("Error improving content:", error);
    throw new Error("Failed to improve content");
  }
}
