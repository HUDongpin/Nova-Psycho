import type { ComponentProps } from "react";
import type { SignIn } from "@clerk/nextjs";
import styles from "./auth.module.css";

// Keep the provider's authentication steps and required branding intact.
// These overrides apply only to the embedded sign-in/sign-up components.
export const authAppearance = {
  options: { elevation: "flush", autoFocus: false },
  variables: {
    colorPrimary: "#2c6058",
    colorPrimaryForeground: "#ffffff",
    colorForeground: "#243833",
    colorMutedForeground: "#526860",
    colorBackground: "#ffffff",
    colorInput: "#ffffff",
    colorInputForeground: "#243833",
    colorBorder: "#82958c",
    colorRing: "#2c6058",
    colorDanger: "#8c3e32",
    fontFamily: "var(--auth-sans)",
    fontSize: "0.875rem",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: styles.clerkRoot,
    cardBox: styles.clerkCardBox,
    card: styles.clerkCard,
    header: styles.clerkHeader,
    headerTitle: styles.clerkTitle,
    headerSubtitle: styles.clerkSubtitle,
    formFieldInput: styles.clerkInput,
    formFieldLabel: styles.clerkLabel,
    otpCodeFieldInputs: styles.clerkOtpGroup,
    otpCodeFieldInput: styles.clerkOtpInput,
    formButtonPrimary: styles.clerkButton,
    footer: styles.clerkFooter,
    footerAction: styles.clerkFooterAction,
    footerActionText: styles.clerkFooterText,
    footerActionLink: styles.clerkLink,
    footerPages: styles.clerkFooterPages,
    footerPagesLink: styles.clerkFooterPages,
  },
} satisfies NonNullable<ComponentProps<typeof SignIn>["appearance"]>;
