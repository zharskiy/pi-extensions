import { normalizeQuestions, type QuestionInput } from "../../src/result.ts";

export const SCOPE: QuestionInput = {
  id: "scope",
  label: "Scope",
  prompt: "Which part should change?",
  options: [
    { value: "frontend", label: "Frontend only" },
    { value: "backend", label: "Backend only", description: "Keep the UI as it is" },
  ],
};

export const PRIORITY: QuestionInput = {
  id: "priority",
  label: "Priority",
  prompt: "How urgent is it?",
  options: [
    { value: "now", label: "Now" },
    { value: "later", label: "Later" },
  ],
  allowOther: false,
};

export const questions = (...inputs: QuestionInput[]) => normalizeQuestions(inputs);
