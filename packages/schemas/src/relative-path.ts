import { z } from "zod";

export const relativePathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    const normalized = value.replace(/\\/g, "/");
    return (
      !normalized.startsWith("/") &&
      !/^[a-zA-Z]:\//.test(normalized) &&
      !normalized.split("/").includes("..")
    );
  }, "Paths must be relative and cannot contain .. segments");
