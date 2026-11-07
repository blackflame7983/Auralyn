import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// index.css の --text-ui-* は文字の大きさ。色の text-* と同じ組と見なされて消えないようにする。
const twMerge = extendTailwindMerge({ extend: { classGroups: { "font-size": [{ text: ["ui-heading", "ui-control", "ui-support"] }] } } })

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
}
