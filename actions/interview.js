"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";

import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = ai.models;

export async function generateQuiz() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
    select: {
      industry: true,
      skills: true,
    },
  });

  if (!user) throw new Error("User not found");

  const prompt = `
    Generate 10 technical interview questions for a ${
      user.industry
    } professional${
    user.skills?.length ? ` with expertise in ${user.skills.join(", ")}` : ""
  }.

    Each question should be multiple choice with 4 options.

    Return the response in this JSON format only, no additional text:
    {
      "questions": [
        {
          "question": "string",
          "options": ["string", "string", "string", "string"],
          "correctAnswer": "string",
          "explanation": "string"
        }
      ]
    }
  `;

  try {
    const result = await model.generateContent({
      model: "gemini-2.5-pro",
      contents: prompt,
    });
    // Robust response extraction
    let text;
    if (typeof result?.text === "string") {
      text = result.text;
    } else if (typeof result?.response?.text === "string") {
      text = result.response.text;
    } else if (
      result?.response?.candidates?.[0]?.content?.parts &&
      Array.isArray(result.response.candidates[0].content.parts)
    ) {
      text = result.response.candidates[0].content.parts.map((p) => p.text || "").join("");
    } else {
      console.warn("Unexpected response shape from GenAI SDK, printing raw response");
      console.log(JSON.stringify(result, null, 2));
      throw new Error("AI returned no text");
    }
    const cleaned = text.replace(/```json|```/g, "").trim();
    const quiz = JSON.parse(cleaned);
    return quiz.questions;
  } catch (error) {
    console.error("Error generating quiz:", error);
    throw new Error("Failed to generate quiz questions");
  }
}

export async function saveQuizResult(questions, answers, score) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  const questionResults = questions.map((q, index) => ({
    question: q.question,
    answer: q.correctAnswer,
    userAnswer: answers[index],
    isCorrect: q.correctAnswer === answers[index],
    explanation: q.explanation,
  }));

  const wrongAnswers = questionResults.filter((q) => !q.isCorrect);

  let improvementTip = null;

  if (wrongAnswers.length > 0) {
    const wrongQuestionsFormatted = wrongAnswers
      .map(
        (q) =>
          `Question: "${q.question}"\nCorrect Answer: "${q.answer}"\nUser Answer: "${q.userAnswer}"`
      )
      .join("\n\n");

    const prompt = `
      The user got these interview questions wrong:

      ${wrongQuestionsFormatted}

      Give a short 1–2 sentence improvement tip.
      Encourage the user. Do NOT restate the questions.
    `;

    try {
      const tipResult = await model.generateContent({
        model: "gemini-2.5-pro",
        contents: prompt,
      });
      let tipText;
      if (typeof tipResult?.text === "string") {
        tipText = tipResult.text;
      } else if (typeof tipResult?.response?.text === "string") {
        tipText = tipResult.response.text;
      } else if (
        tipResult?.response?.candidates?.[0]?.content?.parts &&
        Array.isArray(tipResult.response.candidates[0].content.parts)
      ) {
        tipText = tipResult.response.candidates[0].content.parts.map((p) => p.text || "").join("");
      } else {
        console.warn("Unexpected response shape from GenAI SDK, printing raw response");
        console.log(JSON.stringify(tipResult, null, 2));
        throw new Error("AI returned no text");
      }
      improvementTip = tipText.trim();
    } catch (err) {
      console.error("Error generating improvement tip:", err);
    }
  }

  try {
    const assessment = await db.assessment.create({
      data: {
        userId: user.id,
        quizScore: score,
        questions: questionResults,
        category: "Technical",
        improvementTip,
      },
    });

    return assessment;
  } catch (error) {
    console.error("Error saving quiz result:", error);
    throw new Error("Failed to save quiz result");
  }
}

export async function getAssessments() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  try {
    const assessments = await db.assessment.findMany({
      where: {
        userId: user.id,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return assessments;
  } catch (error) {
    console.error("Error fetching assessments:", error);
    throw new Error("Failed to fetch assessments");
  }
}
