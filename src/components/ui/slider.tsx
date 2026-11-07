import * as React from "react"
import * as SliderPrimitive from "@radix-ui/react-slider"

import { cn } from "@/lib/utils"

const Slider = React.forwardRef<
    React.ElementRef<typeof SliderPrimitive.Root>,
    React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, "aria-label": label, "aria-labelledby": labelledBy, "aria-describedby": describedBy, "aria-valuetext": valueText, ...props }, ref) => (
    <SliderPrimitive.Root
        ref={ref}
        className={cn(
            "relative flex touch-none select-none items-center before:absolute before:left-1/2 before:top-1/2 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
            props.orientation === "vertical" ? "flex-col w-2 h-full before:w-6 before:h-full" : "w-full h-2 before:w-full before:h-6",
            className
        )}
        {...props}
    >
        <SliderPrimitive.Track className={cn(
            "relative grow overflow-hidden rounded-full bg-secondary",
            props.orientation === "vertical" ? "w-full h-full" : "h-full w-full"
        )}>
            <SliderPrimitive.Range className={cn(
                "absolute bg-primary",
                props.orientation === "vertical" ? "w-full bottom-0" : "h-full left-0"
            )} />
        </SliderPrimitive.Track>
        {/* 20pxの外観と行の高さを保ち、透明な疑似要素で24pxの操作領域を確保する。 */}
        <SliderPrimitive.Thumb aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-valuetext={valueText} className="relative block h-5 w-5 before:absolute before:left-1/2 before:top-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] rounded-full border-2 border-primary bg-background ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50" />
    </SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
