import type { LegalDoc } from "./types";

/**
 * Terms of Service — English version.
 *
 * This is a full, self-standing English text (not a summary), drafted to mirror the
 * Chinese version section for section. The Chinese text is controlling where the two
 * differ in meaning or interpretation; that hierarchy is stated in Section XVII and in
 * the page header, and it is deliberate — it is what makes it safe to publish both.
 *
 * Same four rules as the Chinese draft:
 * 1. No blanket exclusion of liability — excluded by Civil Code art. 506 (CN), public
 *    policy (US) and UCTA (SG), and over-reaching language can invalidate the clause.
 * 2. Every disclaimer states the mechanism, not just adjectives.
 * 3. Clauses that limit rights are conspicuous (Civil Code art. 496).
 * 4. Three jurisdictions coexist by layering + mandatory-law precedence + severability.
 */

export const TERMS_EN: LegalDoc = {
  lang: "en",
  title: "Terms of Service",
  intro:
    "These Terms of Service (these \"Terms\") govern your use of Probe (the \"Service\") and form an agreement between you and {operator} (\"we\", \"us\", the \"Service\"). " +
    "Please read them in full, in particular Sections XI through XV (warranty disclaimer, limitation of liability, indemnification, governing law and dispute resolution), which materially affect what you may claim if a dispute arises. " +
    "By clicking \"Agree and continue\" in the in-app confirmation layer, by registering an account, or by continuing to use the Service, you confirm that you have read, understood and agreed to these Terms. If you do not agree, do not use the Service.",
  sections: [
    {
      heading: "I. Parties, Definitions and Effective Date",
      blocks: [
        {
          kind: "list",
          items: [
            "**Service** means the Probe retrieval and verification service, including its web pages, interfaces and all output it generates. The Service is currently an invitation-only test deployment and is not open to public registration.",
            "**You** means the natural person using the Service, or the organisation on whose behalf that person is lawfully acting. If you use the Service on behalf of an organisation, you represent that you are authorised to bind that organisation to these Terms.",
            "**Generated Output** means summaries, data panels, translations, judgement annotations and explanatory text produced or rewritten by artificial-intelligence models.",
            "**Source Material** means third-party pages, documents and excerpts retrieved by the Service. Source Material is the responsibility of its original publisher; we provide only the reference and the excerpt.",
            "These Terms take effect on {effective} and supersede all prior versions. Document version: {version} (derived from a hash of the body text; any change to the body produces a new version).",
          ],
        },
      ],
    },
    {
      heading: "II. What the Service Is — and Is Not",
      blocks: [
        {
          kind: "p",
          text: "The Service accepts a query you enter, calls third-party retrieval services and artificial-intelligence models, and returns a summary, a data panel, a list of sources and a translation. Every figure it shows carries a clickable link to the underlying text — **the underlying text controls**. We do not originate facts; we collect, structure and cross-annotate them.",
        },
        { kind: "p", text: "The Service is **not**:" },
        {
          kind: "list",
          items: [
            "a fact-finding body, news organisation or publisher;",
            "a law firm, accounting firm, investment adviser, medical provider, or a substitute for any licensed professional service. No attorney–client, physician–patient, fiduciary or other professional relationship of any kind is created by your use of the Service;",
            "a consumer reporting agency. Output from the Service must not be used for any purpose within the meaning of the Fair Credit Reporting Act (15 U.S.C. §1681 et seq.) — including credit, employment, insurance, housing or any other eligibility determination — and must not be an input to any automated decision about a person;",
            "a content-hosting platform or distribution channel. The Service offers no public posting, commenting, uploading or distribution features;",
            "an anonymous or encrypted communications tool. Your queries are transmitted to third-party processors as described in Section VIII.",
          ],
        },
      ],
    },
    {
      heading: "III. Mandatory Reading and Electronic Assent ({readSeconds} Seconds)",
      blocks: [
        {
          kind: "list",
          items: [
            "The Service presents a confirmation layer summarising the key clauses. \"Agree and continue\" becomes clickable **only after you have remained for {readSeconds} seconds and read to the end of the summary**. The purpose is to ensure you have a reasonable opportunity to notice the disclaimer and limitation-of-liability clauses rather than being bound without knowledge of them.",
            "When you click to confirm, the server records **the time of confirmation, the document version, and a hashed fingerprint of the network address** as evidence of your assent. That record contains no plaintext IP address; see the Privacy Policy.",
            "These Terms are concluded electronically and have the same effect as a signed paper instrument. You confirm that the device and account you use are under your control.",
            "Assent to a superseded version lapses automatically when these Terms are revised: you will be asked to confirm again, and you may not continue using the Service until you do.",
          ],
        },
      ],
    },
    {
      heading: "IV. Accounts, Invitations and Account Security",
      blocks: [
        {
          kind: "list",
          items: [
            "Access is by invitation. Invitation codes are issued by the operator, are single-use, and are stored server-side only as hashes; they cannot be recovered or reconstructed.",
            "Accounts are personal. You may not transfer, rent, share or sell an account, and activity performed through your account is treated as your own.",
            "You must keep your password secure. If you believe your account is being used by someone else, revoke the sessions and change your password from the Account page immediately.",
            "To comply with real-identity and content-management requirements, the operator may require additional identity verification. If you decline, you may be unable to continue using the Service.",
            "You may request deletion of your account at any time. Once deleted, the account and its session history cannot be restored.",
          ],
        },
      ],
    },
    {
      heading: "V. Limits of AI-Generated Output and Your Duty to Verify",
      blocks: [
        {
          kind: "callout",
          text: "Generated Output is produced by statistical models and **may contain errors, outdated information, misattributed citations or incomplete inferences**. Its purpose is to reduce your reading cost. It is not a confirmation of any fact and is not professional advice of any kind.",
        },
        {
          kind: "list",
          items: [
            "Before you rely on or republish anything, open the original source. This applies in particular to claims marked as unverified, disputed or inferred.",
            "Do not make Generated Output the sole basis for any medical, legal, tax, investment, accounting, safety, employment or immigration decision. Decisions affecting personal safety, significant property or the rights of others must be reviewed by a qualified professional.",
            "When you publish, retain the AI-generation notice. Do not present model output as your own independently verified conclusion, and do not publish it under another person's name.",
            "Model output may resemble existing works; that is inherent to statistical generation. We make no warranty of originality or non-infringement.",
            "Generated Output does not express the views or position of the Service.",
          ],
        },
      ],
    },
    {
      heading: "VI. Prohibited Uses and Prohibited Conduct",
      blocks: [
        { kind: "p", text: "You are free to search, read and export your own results. The following uses and conduct are prohibited:" },
        {
          kind: "list",
          items: [
            "circumventing or attempting to circumvent rate limits, invitation checks, identity checks, regional policy or any other access control;",
            "automated bulk scraping, load testing, scanning, injection, deserialisation attacks or denial-of-service attacks against the Service or its upstream providers;",
            "using the Service or its output for any purpose excluded by Section II (professional advice, consumer reports, automated decisions);",
            "generating or disseminating unlawful content, or infringing the reputation, privacy, likeness, copyright, trade-secret or personal-information rights of others;",
            "profiling, monitoring, doxxing or de-anonymising any natural person, or making decisions adverse to a person on the basis of Generated Output;",
            "reselling the Service as an intermediary layer for third parties, including exposing it as an API, redistributing result sets, or embedding it in a commercial product;",
            "sharing one account among several people, or driving one session concurrently by script;",
            "removing, obscuring or forging the AI-generation notice, regulatory filings or links to these Terms.",
          ],
        },
        {
          kind: "p",
          text: "On discovering such conduct the operator may immediately restrict or terminate the account and reserves all rights of recourse, without prior notice, and without refund of any fees already paid. Where a criminal offence is suspected, the matter will be reported to the competent authority.",
        },
      ],
    },
    {
      heading: "VII. Your Content, Our Content and Third-Party Content",
      blocks: [
        {
          kind: "list",
          items: [
            "Queries and feedback you submit remain yours. To provide the Service, you authorise us to store them, cache them and transmit them to third-party models and retrieval services for processing to the extent necessary (see the Privacy Policy).",
            "The interface, code, structured-panel styling, prompt orchestration and product design belong to the operator. You may not copy, mirror, decompile or use them commercially without permission.",
            "**Third-party content.** Text, titles, summaries and images in search results remain the copyright of their respective sites and authors; we provide only references and excerpts. You are responsible for obtaining any permission required for your own use of that content and for complying with the original site's licence terms.",
            "**Notice and takedown.** If you believe an excerpt on the Service infringes your rights, send proof of ownership, the specific link and your contact details to {contact}; we will remove or disable access after verification. Notices under the Digital Millennium Copyright Act (17 U.S.C. §512) should be marked \"DMCA Notice\"; we accept the notice-and-takedown procedure set out in that section, and you are responsible for the consequences of a materially misrepresenting notice.",
            "We do not pre-screen third-party content and do not endorse it merely because it was retrieved.",
          ],
        },
      ],
    },
    {
      heading: "VIII. Third-Party Services, Cross-Border Processing and Regional Routing",
      blocks: [
        {
          kind: "list",
          items: [
            "A single search transmits **your query terms** as request content to third-party retrieval and model services (for example Tavily, Bocha, GDELT, Wikipedia, Hacker News, and any model provider configured by you or by the deployment operator). Those providers have their own terms and privacy policies, and we do not control their conduct.",
            "To comply with data-export and content rules in each region, the Service determines a region from the access origin and uses it to decide which retrieval sources and model endpoints are available. The basis for that determination and the resulting processing are described in Section 3 of the Privacy Policy.",
            "You understand and agree that, to complete a search, the necessary information is transferred across borders to the countries or regions where those providers operate. If you do not accept this, stop using the Service.",
            "Outages, rate limiting, price changes or discontinuation by third-party providers may make parts of the Service unavailable. That is not a breach by the Service.",
          ],
        },
      ],
    },
    {
      heading: "IX. Changes, Suspension and Termination",
      blocks: [
        {
          kind: "list",
          items: [
            "The Service may change its features, models or retrieval sources at any time, and may be interrupted for maintenance, upstream failure or regulatory requirements.",
            "The Service is provided \"as is\" and \"as available\". We make no commitment as to availability, continuity, response time or freedom from error.",
            "You may stop using the Service and request account deletion at any time. The operator may discontinue all or part of the Service after prior notice.",
            "After termination we will delete or anonymise your data within a reasonable period, except for information we are required by law to retain.",
          ],
        },
      ],
    },
    {
      heading: "X. Fees and Free Period",
      blocks: [
        {
          kind: "p",
          text: "The Service is free of charge during the current test period. If paid plans are introduced, they will be announced in the Service in advance with clear pricing; no charge arises unless you actively subscribe. A free period is not a promise that the Service will remain free, nor a commitment as to service levels.",
        },
      ],
    },
    {
      heading: "XI. Disclaimer of Warranties",
      blocks: [
        {
          kind: "callout",
          text: "TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICE AND ITS OPERATOR AND CONTRIBUTORS EXPRESSLY DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, COMPLETENESS OR UNINTERRUPTED OPERATION.",
        },
        {
          kind: "list",
          items: [
            "We do not warrant that Generated Output is correct, complete or current, or that it is fit for your particular purpose.",
            "We do not warrant that retrieval covers every relevant source: a source that was not retrieved is not thereby shown not to exist, and a source that was retrieved is not thereby shown to be true.",
            "We do not warrant that the Service will be uninterrupted, error-free or free of latency, or that it is fully compatible with your device, network or browser.",
            "We do not warrant that third-party services and external links remain available, or that their content is lawful, safe or harmless.",
            "We do not warrant that the Service is free of viruses, malware or other harmful components; take your own protective measures.",
            "Any decision you make in reliance on Generated Output, and its consequences, are your own. This sentence does not apply to liability that cannot be excluded by its nature (see Section XV).",
          ],
        },
      ],
    },
    {
      heading: "XII. Limitation of Liability",
      blocks: [
        {
          kind: "callout",
          text: "TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE OPERATOR IS NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST GOODWILL, LOSS OF DATA OR BUSINESS INTERRUPTION, ARISING OUT OF OR RELATING TO YOUR USE OF OR INABILITY TO USE THE SERVICE, WHETHER BASED ON CONTRACT, TORT, STRICT LIABILITY OR ANY OTHER THEORY, AND WHETHER OR NOT THE POSSIBILITY OF SUCH DAMAGES WAS ADVISED.",
        },
        { kind: "p", text: "The operator's **aggregate liability** to you for the Service, whether in one claim or several, shall not exceed the lower of:" },
        {
          kind: "list",
          items: [
            "the total amount you actually paid for use of the Service in the twelve months preceding the event giving rise to the claim; and",
            "CNY 100 (or the equivalent of USD 15 / SGD 20).",
          ],
        },
        {
          kind: "p",
          text: "During any period of free use, that amount is zero. You must bring a claim **within one year** after the cause of action accrues, or it is waived (in any jurisdiction that does not permit a contractual reduction of the limitation period, the shortest period that jurisdiction allows applies).",
        },
        {
          kind: "p",
          text: "This Section does not apply to damage caused intentionally or by gross negligence, to personal injury, to fraud or fraudulent misrepresentation, or to any liability that cannot be excluded or limited by its nature.",
        },
      ],
    },
    {
      heading: "XIII. Indemnification (You → Us)",
      blocks: [
        {
          kind: "p",
          text: "To the extent permitted by applicable law, you agree to indemnify and hold harmless the Service, its operator, affiliates and contributors from any third-party claim, action or regulatory investigation, including reasonable legal fees and costs, arising from:",
        },
        {
          kind: "list",
          items: [
            "your breach of these Terms, in particular the prohibited uses in Section VI;",
            "queries or content you submit that infringe the rights of others;",
            "your use of Generated Output for a purpose these Terms exclude (including any FCRA purpose or any professional-advice use);",
            "your unauthorised use of another person's account, or your permitting another person to use yours.",
          ],
        },
        {
          kind: "p",
          text: "We reserve the right to select our own defence and settlement strategy, and you will cooperate reasonably after receiving notice. This Section does not apply to claims caused by our own fault.",
        },
      ],
    },
    {
      heading: "XIV. Governing Law and Dispute Resolution",
      blocks: [
        {
          kind: "p",
          text: "The parties will first attempt to resolve any dispute in good faith. If no resolution is reached **within thirty (30) days** of written notice from one party to the other (sent to {contact}), the dispute will be handled as set out below for your location. If you are located outside the regions listed, item (ix) applies.",
        },
        {
          kind: "list",
          items: [
            "**(i) Users in mainland China.** These Terms are governed by the laws of the People's Republic of China (excluding, for this purpose, the laws of the Hong Kong and Macao Special Administrative Regions and of the Taiwan region). Failing agreement, the dispute shall be submitted to the competent people's court at the operator's place of establishment. Nothing in this Section excludes rights you hold under mandatory provisions such as the Law of the People's Republic of China on the Protection of Consumer Rights and Interests.",
            "**(ii) Users in the United States.** These Terms are governed by the law of the state in which you reside, together with the provisions of these Terms, and matters within the Federal Arbitration Act (9 U.S.C. §1 et seq.) are governed by federal law. Except as stated below, the parties agree to resolve all disputes by **binding individual arbitration** rather than in court, administered by JAMS under its consumer rules (or another administrator agreed in writing), conducted remotely or near your residence, in English. **Both parties waive any right to trial by jury, and waive participation in any class action, class arbitration or representative proceeding.** Exceptions: a dispute within the jurisdictional limit of a small-claims court where you reside may be brought in that court, and either party may seek injunctive relief in any court of competent jurisdiction for infringement of intellectual property or unauthorised access to the Service. You may opt out of this arbitration agreement by written notice to {contact}, headed \"Arbitration Opt-Out\", **within thirty (30) days** of first accepting these Terms, without giving reasons; if you do not opt out in time, you accept it. Opting out does not affect any other provision of these Terms.",
            "**(iii) Users in Singapore.** These Terms are governed by the laws of Singapore. Failing agreement, the dispute shall be submitted to the courts of Singapore, or, by written agreement of both parties, to arbitration administered by the Singapore International Arbitration Centre (SIAC) under its rules in force, seated in Singapore, in English. If you are a consumer protected by the Consumer Protection (Fair Trading) Act (CPFTA) or the Unfair Contract Terms Act (UCTA), nothing in these Terms excludes or restricts any right you hold under those Acts that cannot lawfully be excluded; to that extent, any conflicting provision of these Terms does not apply.",
            "**(iv) Users in Hong Kong.** These Terms are governed by the laws of the Hong Kong Special Administrative Region. Failing agreement, the dispute shall be submitted to the courts of Hong Kong or, by written agreement of both parties, to arbitration administered by the Hong Kong International Arbitration Centre (HKIAC) under its rules in force, seated in Hong Kong, in English. If you are a consumer protected by the Control of Exemption Clauses Ordinance (Cap. 71) or the Supply of Services (Implied Terms) Ordinance (Cap. 457), nothing in these Terms excludes or restricts any right you hold under those Ordinances that cannot lawfully be excluded; to that extent, any conflicting provision of these Terms does not apply.",
            "**(v) Users in Macao.** These Terms are governed by the laws of the Macao Special Administrative Region. Failing agreement, the dispute shall be submitted to the courts of Macao. If you are a consumer protected by the Consumer Rights Protection Law (Law No. 9/2021), nothing in these Terms excludes or restricts any right you hold under that Law that cannot lawfully be excluded; to that extent, any conflicting provision of these Terms does not apply.",
            "**(vi) Users in Taiwan.** These Terms are governed by the laws of the Taiwan region. Failing agreement, the dispute shall be submitted to the competent court in the Taiwan region. These Terms are standard-form contract terms within the meaning of Article 247-1 of the Civil Code of the Taiwan region, and any part that is manifestly unfair to you in the circumstances is invalid to that extent. Nothing in these Terms excludes rights you hold under the Consumer Protection Act of the Taiwan region; the reasonable review period contemplated by Article 11-1 of that Act is provided by Section III (the {readSeconds}-second stay together with the requirement to scroll to the end).",
            "**(vii) Users in Malaysia.** These Terms are governed by the laws of Malaysia. Failing agreement, the dispute shall be submitted to the courts of Malaysia or, by written agreement of both parties, to arbitration administered by the Asian International Arbitration Centre (AIAC) under its rules in force, seated in Kuala Lumpur, in English, pursuant to the Arbitration Act 2005. If you are a consumer protected by the Consumer Protection Act 1999, nothing in these Terms excludes or restricts any right you hold under that Act (including the control of unfair contract terms in section 24) that cannot lawfully be excluded.",
            "**(viii) Users in Japan.** These Terms are governed by the laws of Japan. Failing agreement, the Tokyo District Court shall have jurisdiction in the first instance. These Terms constitute standard terms (定型約款) within the meaning of Article 548-2 of the Civil Code of Japan; where a provision is void under Articles 8 to 10 of the Consumer Contract Act, that provision does not apply to that extent and the remaining provisions continue in effect. Nothing in these Terms excludes or restricts any right conferred on you by the Consumer Contract Act, the Act on Specified Commercial Transactions, or the Act on the Protection of Personal Information of Japan that cannot be waived by agreement.",
            "**(ix) Users elsewhere.** These Terms are governed by the law of the operator's place of establishment (the laws of the People's Republic of China). Failing agreement, the dispute shall be submitted to the competent people's court at the operator's place of establishment, except where mandatory law in your own jurisdiction requires your local courts, in which case that requirement prevails.",
          ],
        },
        {
          kind: "p",
          text: "Nothing in this Section prevents either party from seeking interim or permanent injunctive relief in any court of competent jurisdiction against infringement of intellectual property, circumvention of access controls, or conduct endangering the security of the Service.",
        },
      ],
    },
    {
      heading: "XV. Mandatory Law Prevails; Severability",
      blocks: [
        {
          kind: "callout",
          text: "Nothing in these Terms excludes or limits any liability that cannot be excluded or limited by its nature, including liability for property damage caused intentionally or by gross negligence, for personal injury, for fraud or fraudulent misrepresentation, and any consumer right that law expressly makes non-excludable.",
        },
        {
          kind: "list",
          items: [
            "If any provision of these Terms is held invalid, unenforceable or beyond what is permitted in a jurisdiction, that provision shall be adjusted **within that jurisdiction** to the minimum extent necessary to make it enforceable while preserving its intent, and the remaining provisions remain in full effect; their validity elsewhere is unaffected.",
            "Where these Terms conflict with a mandatory rule of law, the mandatory rule prevails and the remainder continues to apply.",
            "Nothing in these Terms waives any statutory obligation or disposes of any third party's rights.",
          ],
        },
      ],
    },
    {
      heading: "XVI. Updates to These Terms",
      blocks: [
        {
          kind: "p",
          text: "These Terms may be updated as features and regulations change; an updated version is published on this page with its effective date and version number (currently {version}, generated automatically from a hash of the body). Where a change materially affects your rights, it will be announced in the Service and **you will be required to confirm again**; you may not continue using the Service until you do. You may view the current version number on this page at any time.",
        },
      ],
    },
    {
      heading: "XVII. Miscellaneous",
      blocks: [
        {
          kind: "list",
          items: [
            "These Terms and the Privacy Policy together constitute the entire agreement between you and us regarding the Service and supersede any prior oral or written statement.",
            "Our failure or delay in exercising any right under these Terms is not a waiver of that right.",
            "You may not assign your rights or obligations under these Terms without our written consent; we may assign them in connection with a merger, acquisition or transfer of assets.",
            "**The Chinese version of these Terms controls.** The English and Japanese texts are official translations of the same instrument; where the Chinese, English and Japanese differ in meaning, the Chinese version prevails.",
            "Headings are for convenience only and do not affect interpretation.",
          ],
        },
      ],
    },
    {
      heading: "XVIII. Contact and Complaints",
      blocks: [
        { kind: "p", text: "Questions about these Terms, rights notices and arbitration opt-out notices may be sent to {contact}; we will respond within 15 business days." },
        {
          kind: "list",
          items: [
            "Mainland China: you may also report to the local cyberspace administration, the market regulator, or the 12377 reporting centre.",
            "United States: you may complain to the Federal Trade Commission or your state attorney general; a complaint does not change the dispute-resolution method agreed in these Terms.",
            "Singapore: you may seek assistance from the Consumers Association of Singapore (CASE).",
            "Hong Kong: data-protection complaints may be made to the Office of the Privacy Commissioner for Personal Data (PCPD); consumer disputes may be referred to the Consumer Council.",
            "Macao: you may raise data-protection matters with the Office for Personal Data Protection (DSPDP), and consumer matters with the Consumer Council of Macao.",
            "Taiwan: you may contact the Consumer Protection Committee of the Executive Yuan, your local consumer service centre (1950 hotline), or the competent personal-data authority.",
            "Malaysia: you may contact the Ministry of Domestic Trade and Cost of Living (KPDN), the Department of Personal Data Protection (JPDP), or the Federation of Malaysian Consumers Associations (FOMCA).",
            "Japan: you may consult the Consumer Affairs Agency, the National Consumer Affairs Centre of Japan, or the Personal Information Protection Commission.",
          ],
        },
      ],
    },
    {
      heading: "Appendix I: Statutory References",
      blocks: [
        {
          kind: "p",
          text: "The provisions below are the basis for the design of each Section. They are listed not for decoration but so that, if a clause is challenged, it is clear why it is drafted as it is and where its boundary lies.",
        },
        {
          kind: "list",
          items: [
            "Civil Code of the People's Republic of China, art. 496 — duty to highlight and explain standard-form clauses. Basis for Section III and for the callout blocks throughout.",
            "Civil Code of the People's Republic of China, art. 497 — a standard-form clause is invalid where the drafting party unreasonably exempts or reduces its own liability, increases the other party's liability, or restricts the other party's principal rights. Basis for Section XV, and the reason no blanket \"we are not liable for anything\" language appears here.",
            "Civil Code of the People's Republic of China, art. 506 — exemption clauses are invalid for personal injury and for property damage caused intentionally or by gross negligence. Basis for the reservations at the end of Sections XI and XII.",
            "Cybersecurity Law of the People's Republic of China, arts. 21, 24, 41–43 — real-identity requirements, retention of logs for not less than six months, and the lawfulness, legitimacy and necessity principles for personal information. Basis for Section IV and Sections 4 and 7 of the Privacy Policy.",
            "Personal Information Protection Law of the People's Republic of China, arts. 13, 17, 38–39 — legal bases for processing, notice obligations, and separate consent and notice for cross-border transfers. Basis for Section VIII and Sections 3 and 5 of the Privacy Policy.",
            "E-Commerce Law of the People's Republic of China, arts. 32, 33 — publication of platform rules and user agreements, public consultation and notice before amendment. Basis for Section XVI.",
            "Interim Measures for the Management of Generative Artificial Intelligence Services, arts. 4, 9, 12, 15 — prohibition on unlawful content, provider responsibility and complaint handling, and labelling of generated content. Basis for Sections V, VI and VII.",
            "Provisions on the Administration of Deep Synthesis of Internet Information Services, arts. 16–17 — conspicuous labelling of synthetic content that may confuse the public. Basis for \"retain the AI-generation notice\" in Section V.",
            "Fair Credit Reporting Act, 15 U.S.C. §1681 et seq. — permissible purposes and liability for consumer reports. Basis for Section II(3) and Section VI: excluding the Service from any consumer-reporting use is the single most direct US risk control in this instrument.",
            "Digital Millennium Copyright Act, 17 U.S.C. §512 — notice-and-takedown and the safe harbour. Basis for Section VII.",
            "Federal Arbitration Act, 9 U.S.C. §1–16 — validity and enforceability of arbitration agreements. Basis for Section XIV(ii); the 30-day opt-out exists so the clause remains defensible in consumer-arbitration-sensitive states such as California.",
            "Uniform Electronic Transactions Act (UETA) and Electronic Signatures in Global and National Commerce Act (E-SIGN), 15 U.S.C. §7001 et seq. — effect of electronic records and signatures. Basis for Section III.",
            "Unfair Contract Terms Act (Singapore, Cap. 396) and Consumer Protection (Fair Trading) Act (Singapore, Cap. 52A) — non-excludable consumer rights and control of unfair terms. Basis for Section XIV(iii) and Section XV.",
            "Personal Data Protection Act 2012 (Singapore) — notice, consent and cross-border transfer obligations. Basis for the Privacy Policy.",
            "SIAC Rules in force — procedural basis for the arbitration contemplated in Section XIV(iii).",
            "Control of Exemption Clauses Ordinance (Hong Kong, Cap. 71) and Supply of Services (Implied Terms) Ordinance (Hong Kong, Cap. 457) — no contracting out of liability for death or personal injury caused by negligence, and services must be supplied with reasonable care and skill. Basis for Section XIV(iv) and the reservations at the end of Sections XI and XII.",
            "Personal Data (Privacy) Ordinance (Hong Kong, Cap. 486, PDPO) — the six data protection principles, purpose limitation, and access and correction rights. Basis for the Privacy Policy.",
            "Electronic Transactions Ordinance (Hong Kong, Cap. 553) — effect of electronic records and electronic signatures. Basis for the electronic assent in Section III.",
            "Trade Descriptions Ordinance (Hong Kong, Cap. 362) — false trade descriptions of services and misleading omissions. Basis for Sections V and VI, and one reason no 'we guarantee accuracy' language appears in these Terms.",
            "Arbitration Ordinance (Hong Kong, Cap. 609) — validity and enforcement of arbitration agreements. Basis for the HKIAC option in Section XIV(iv).",
            "Civil Code of Macao (approved by Decree-Law No. 39/99/M) — formation of contract, declarations of intent and the interpretation of general terms. Basis for Sections I and XIV.",
            "Personal Data Protection Law (Macao, Law No. 8/2005) — legitimacy of processing, notice, and cross-border transfer. Basis for the Privacy Policy.",
            "Consumer Rights Protection Law (Macao, Law No. 9/2021) — consumers' right to accurate and clear information and the control of unfair terms. Basis for Section XIV(v) and Section XV.",
            "Electronic Documents and Electronic Signatures Law (Macao, Law No. 5/2005) — legal effect of electronic documents and signatures. Basis for Section III.",
            "Civil Code of the Taiwan region, Article 247-1 — a standard-form term that is manifestly unfair in the circumstances is invalid to that extent. Basis for Section XIV(vi) and the severability arrangement in Section XV.",
            "Consumer Protection Act of the Taiwan region, Articles 11-1, 12 and 17 — reasonable review period, limits on the enterprise operator's liability, and mandatory and prohibited content in standard-form contracts. Basis for the mandatory reading in Section III and for Sections XI and XII.",
            "Personal Data Protection Act (Taiwan region) and Electronic Signatures Act (Taiwan region) — collection, processing and use of personal data, and the effect of electronic signatures. Basis for the Privacy Policy and Section III.",
            "Contracts Act 1950 (Malaysia) and Consumer Protection Act 1999 (Malaysia), in particular section 24 on unfair contract terms — formation and enforceability of contracts and the non-excludable rights of consumers. Basis for Section XIV(vii) and Section XV.",
            "Personal Data Protection Act 2010 (Malaysia, as amended in 2024) — notice, consent, data-subject rights and cross-border transfer. Basis for the Privacy Policy.",
            "Electronic Commerce Act 2006 (Malaysia) and Communications and Multimedia Act 1998 (Malaysia) — effect of electronic messages and signatures, and the regulation of network services and content. Basis for Section III and Sections V and VI.",
            "Arbitration Act 2005 (Malaysia) and the AIAC Rules in force — procedural basis for the arbitration contemplated in Section XIV(vii).",
            "Civil Code of Japan, Article 548-2 — incorporation and modification of standard terms (定型約款). Basis for Section XIV(viii).",
            "Consumer Contract Act (Japan), Articles 8 to 10 — exemption or partial exemption of the business operator's liability for damages, restriction of the consumer's right to rescind, and invalidity of other unfair terms. This is the sharpest boundary for these Terms under Japanese law: to the extent Sections XI and XII touch those provisions, they do not apply.",
            "Act on Specified Commercial Transactions (Japan) — disclosure duties for mail-order sales. Basis for Section X and for the operator information published in the Service.",
            "Act on the Protection of Personal Information (Japan) — notification and publication of the purpose of use, consent for provision to third parties and cross-border transfer, and rights of disclosure and correction. Basis for the Privacy Policy.",
            "Electronic Signatures Act (Japan) — presumption of authenticity of electronic signatures. Basis for the electronic assent in Section III.",
            "Provider Liability Limitation Act (Japan) — transmission prevention measures and disclosure of sender information. Basis for the notice-and-takedown mechanism in Section VII, which operates alongside the DMCA for users in different jurisdictions.",
            "Arbitration Act (Japan, Act No. 138 of 2003) — validity of arbitration agreements and enforcement of awards.",
            "The 'mandatory law prevails' rule in Section XV is not decoration: most of the consumer-protection instruments listed above expressly prohibit contracting out of certain liabilities. Their relationship with Sections XI and XII is not one of precedence but of scope — within the statutory limits those clauses simply do not operate.",
          ],
        },
      ],
    },
    {
      heading: "Appendix II: Key Definitions and Calculation Conventions",
      blocks: [
        {
          kind: "list",
          items: [
            "\"amount actually paid in the twelve months\": determined by settlement records; excludes charges billed to you by third parties (such as model providers) and excludes your own network and equipment costs.",
            "\"date the cause of action accrues\": the earlier of the date you first knew, or ought reasonably to have known, of the damage and of the party responsible.",
            "\"written notice\": an email is delivered when it reaches the operator's mailbox; an arbitration opt-out notice must state your account name and the version of these Terms you accepted.",
            "\"document version\": the first 12 hexadecimal characters of the SHA-256 hash of the body text (Chinese and English); any change to the body produces a new version, and prior assent lapses.",
          ],
        },
      ],
    },
  ],
};
