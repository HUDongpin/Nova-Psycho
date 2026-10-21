"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import type { Locale } from "./api";
import { copy } from "./copy";
import { Brand, LocaleSwitch } from "./ui";
import styles from "./auth.module.css";

export function AuthShell({ locale, onLocaleChange, children, afterCard, variant = "entry" }: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  children: ReactNode;
  afterCard?: ReactNode;
  variant?: "entry" | "email";
}) {
  const t = copy(locale);
  const [introduction, invitation] = t("loginIntro").split("，");
  return <main className={`login-page ${styles.page} ${variant === "entry" ? styles.entryPage : ""}`} lang={locale}>
    <header className={styles.header}>
      <Brand />
      <LocaleSwitch locale={locale} onChange={onLocaleChange} />
    </header>
    <div className={styles.layout} data-auth-panel>
      <section className={styles.visual} data-auth-visual>
        <div className={styles.story}>
          <p className={styles.eyebrow}>{t("authEyebrow")}</p>
          <h1><span>{introduction}，</span><span>{invitation}</span></h1>
          <p>{t("tagline")}</p>
        </div>
        <figure className={styles.figure}>
          <Image src="/auth-companion-v2.png" alt={t("homeFigure")} width={1287} height={1222} sizes="(max-width: 959px) 560px, (max-width: 1545px) 50vw, 762px" />
        </figure>
      </section>
      <div className={styles.formColumn} data-auth-form>
        <section className={`login-card ${styles.card}`} aria-label={t("authCardLabel")}>{children}</section>
      </div>
    </div>
    {afterCard && <div className={styles.afterCard}>{afterCard}</div>}
    <footer className={styles.footer}>TopE<span aria-hidden="true">·</span>{t("tagline")}</footer>
  </main>;
}
