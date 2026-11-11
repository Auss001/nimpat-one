import { Link } from 'react-router-dom';
import { PageTitle } from '../ui';

const UPDATED = '7 November 2026';
const EMAIL = 'nimpatinternational@gmail.com';
const PHONE_TEXT = '+234 818 833 6209';
const ADDRESS = 'Crownet Plaza, Wuye, Abuja, Nigeria';

type Section = [heading: string, ...paragraphs: string[]];

const PRIVACY: Section[] = [
  ['Who we are', `Nimpat One is run by NIMPAT Group of Companies, ${ADDRESS}. For any privacy question or request, email ${EMAIL} or call ${PHONE_TEXT}.`],
  [
    'What we collect',
    'Your account: your name, email address and password, and your phone number if you add it. Your password is stored in a scrambled form that our staff cannot read.',
    'Your orders and bookings: what you order or book, dates, guest numbers, notes you add, delivery addresses, landmarks, and the name and phone number of the person receiving a delivery.',
    'Your payments: the amount, method, reference and status. Card details are entered with Paystack, and we do not store them. If you pay by bank transfer, we keep any receipt you upload in private storage.',
    'Your activity with us: favourites, basket, Royalty points, car enquiries and messages to our team.',
    'Technical information: standard connection and security logs, which include your network address and device or browser details.',
  ],
  [
    'Health-related information',
    'A pharmacy, laboratory or spa booking, or a note you add to one, can reveal something about your health. We use it only to provide that service and limit it to the staff who need it. Please add only what the team needs.',
  ],
  [
    'How we use it',
    'To run your account, process orders and bookings, take and check payments, deliver, contact you about your order or booking, give customer support and award Royalty points. Staff check payments and prescription items where needed.',
    'To keep the service safe, prevent fraud and misuse, and meet our legal and record-keeping duties.',
    'We process your information because we need it to provide what you asked for, to meet a legal duty, for our legitimate interest in keeping the service secure, or with your consent where consent is required.',
    'We send marketing only if you have chosen to receive it, and you can withdraw that choice at any time. We do not sell your personal information.',
  ],
  [
    'Who we share it with',
    'Nimpat staff who need it for your order or booking, including across the Nimpat businesses you use.',
    'Paystack, to process online payments. Google Cloud, which hosts the app and stores its data. An email provider, to send account and order messages. Delivery staff or partners, who receive what they need to reach you.',
    'Authorities or advisers, where the law requires it or where it is needed to protect legal rights.',
  ],
  [
    'Storage outside Nigeria',
    'The app and its database are hosted on Google Cloud in Belgium, so your information is stored outside Nigeria. Service providers may also handle it in other countries. We rely on the safeguards that Nigerian data protection law requires for these transfers.',
  ],
  [
    'Browser storage and cookies',
    'The app uses your browser’s storage to keep you signed in, remember your recent searches and viewed items, and remember your 18+ confirmation for the current visit. The app does not use advertising or analytics tracking.',
    'The app’s font is loaded from Google Fonts, so Google receives your network address when the page loads. If we add optional tracking, we will update this notice and ask for any consent required first.',
  ],
  [
    'How long we keep it',
    'We keep your information while your account is open and for as long as needed to provide the service, resolve disputes and meet legal, tax and accounting duties.',
  ],
  [
    'Deleting your account',
    'You can delete your account in the app under Account, once any open orders or bookings are finished or cancelled. This signs you out and removes your name, email, phone number, addresses, favourites and basket. Past order and payment records stay, without those details, because we need them for our accounts and legal duties. Step-by-step help, including how to ask us to delete it, is at app.nimpatgroup.com/delete-account.',
  ],
  [
    'Your rights',
    `Subject to the law, you can ask to see, correct, delete, restrict or move your information, object to how we use it, and withdraw consent. Email ${EMAIL}. We may need to confirm it is you first. You can also complain to the Nigeria Data Protection Commission.`,
  ],
  ['Security', 'We use encrypted connections, private storage for receipts and staff access controls. No online service can be guaranteed completely secure, so please keep your password private and tell us if you think your account has been misused.'],
  ['Children', 'Nimpat One is not designed for children. Alcohol is only sold to adults aged 18 and over. A parent or guardian who believes a child has given us information should contact us.'],
  ['Changes to this notice', 'We may update this notice as the service changes. The date at the top shows the latest version, and we will tell you about important changes in the app or by email.'],
];

const TERMS: Section[] = [
  ['About these terms', `These terms apply when you use Nimpat One, run by NIMPAT Group of Companies, ${ADDRESS}. Using the app means you accept them. Your rights under Nigerian consumer and data protection law are not reduced by these terms.`],
  ['Your account', 'Give accurate details and keep your password private. You are responsible for activity on your account unless it was misused through no fault of yours. We may suspend an account that is used for fraud, misuse or unlawful activity.'],
  [
    'Products, prices and pictures',
    'Prices are in Nigerian naira. The total, including any delivery or other charges, is shown before you confirm. Availability can change, and some items need confirming with our staff before checkout.',
    'Some pictures are illustrations and the packaging may differ. If we can’t supply an item, we will tell you. We will not substitute a different product without your agreement.',
    'If a price is clearly wrong because of an error, we will contact you before going ahead, and you may cancel.',
  ],
  [
    'Orders',
    'An order is confirmed when it has been accepted and the payment arrangement applies. Unpaid orders can expire after the time shown. Each Nimpat store checks out separately.',
    'Please give a correct address and a reachable phone number, and check your delivery when it arrives. Tell us promptly if anything is missing, damaged or wrong.',
  ],
  [
    'Payment',
    'The options shown at checkout may include online payment through Paystack, bank transfer, payment on delivery and payment in store. Not every option applies to every order.',
    'Uploading a transfer receipt or reference does not confirm your payment. Your order is treated as paid once our staff have checked that the money has been received.',
  ],
  [
    'Returns and refunds',
    `If an item is faulty, wrong or not as described, contact us at ${EMAIL} or ${PHONE_TEXT} with your order number. Remedies depend on the problem, the product and the law, and any remedy the law requires stays available. We will explain the refund method and timing when it is agreed.`,
  ],
  [
    'Luxury Apartments',
    'The nightly rate and refundable caution deposit are shown before you pay. Your dates tell us when you are arriving and leaving. Your dates are held for a limited time until payment. You can cancel an unpaid hold in the app.',
    'To cancel a paid booking, contact us. Any cancellation conditions will be given to you before you commit, and any charge must be reasonable and lawful. Guests must respect the property, its occupancy limit and its rules.',
  ],
  [
    'Alcohol',
    'Alcohol is only sold to adults aged 18 and over. You may be asked for ID on delivery, and we may refuse to hand over alcohol if age can’t be confirmed.',
  ],
  [
    'Pharmacy and laboratory',
    'Medical information in the app is for general reference only. It is not diagnosis, treatment or dosage advice, and it does not replace a doctor or pharmacist. Some items need pharmacist or prescription verification before they can be supplied, and we may decline to supply them without it.',
  ],
  ['Spa, cars and other services', 'Appointment times are subject to confirmation. A car enquiry is not a sale; check the vehicle’s specification, condition and documents before you pay anything. Further conditions may be given to you before you commit.'],
  ['Using the app properly', 'Do not misuse the app, attempt to gain unauthorised access, interfere with its operation, impersonate anyone or submit false orders, payments or receipts.'],
  ['Names and content', 'Nimpat branding and content belong to Nimpat and may not be reused commercially without permission. Other product names and marks belong to their owners.'],
  ['If something goes wrong', 'The app may sometimes be unavailable because of maintenance or events outside our reasonable control. Nothing in these terms limits any responsibility or remedy that the law does not allow us to limit.'],
  [
    'Complaints and governing law',
    `Please contact us first at ${EMAIL} or ${PHONE_TEXT}, with your order or booking number. These terms are governed by Nigerian law. You can still approach the Federal Competition and Consumer Protection Commission, another regulator or a court.`,
  ],
  ['Changes to these terms', 'We may update these terms as the service changes. Changes do not alter what was already agreed for an order or booking that has been confirmed.'],
];

function LegalPage({ title, sections, other }: { title: string; sections: Section[]; other: { to: string; label: string } }) {
  return (
    <article className="legal">
      <PageTitle title={title} sub={`Last updated ${UPDATED}`} />
      {sections.map(([heading, ...paragraphs]) => (
        <section key={heading} className="panel">
          <h2>{heading}</h2>
          {paragraphs.map((p) => <p key={p}>{p}</p>)}
        </section>
      ))}
      <p className="legal-links"><Link to={other.to}>{other.label}</Link></p>
    </article>
  );
}

export function PrivacyPage() {
  return <LegalPage title="Privacy Policy" sections={PRIVACY} other={{ to: '/terms', label: 'Read the Terms of Use' }} />;
}

export function TermsPage() {
  return <LegalPage title="Terms of Use" sections={TERMS} other={{ to: '/privacy', label: 'Read the Privacy Policy' }} />;
}

const DELETE_ACCOUNT: Section[] = [
  ['Nimpat One', 'This page explains how to delete your Nimpat One account. Nimpat One is run by NIMPAT Group of Companies, shown as Nimpat Group on Google Play and the App Store.'],
  [
    'Delete it in the app',
    '1. Open Nimpat One and sign in.',
    '2. Tap Account at the bottom of the screen.',
    '3. Scroll down and tap Delete my account.',
    '4. Confirm. If you set a password, enter it to confirm it is you.',
    'Any open order or booking must be finished or cancelled first. Deletion happens straight away.',
  ],
  [
    'Or ask us',
    `If you cannot open the app, email ${EMAIL} from the email address on your account, or call ${PHONE_TEXT}, and ask us to delete your Nimpat One account. We confirm it is you, then delete it within 7 days and tell you when it is done.`,
  ],
  [
    'What is deleted',
    'Your name, email address, phone number, saved addresses, favourites, basket, Royalty points, notifications on your phones, and every signed-in session. You are signed out everywhere and the account cannot be used again.',
  ],
  [
    'What is kept, and for how long',
    'Past orders, bookings and payment records stay, without your name or contact details, because the law requires businesses to keep financial records. We keep them for as long as Nigerian tax and accounting law requires, usually six years, and then delete them. Payment receipts you uploaded are kept for the same time, privately.',
  ],
];

export function DeleteAccountPage() {
  return <LegalPage title="Delete your Nimpat One account" sections={DELETE_ACCOUNT} other={{ to: '/privacy', label: 'Read the Privacy Policy' }} />;
}

/** Quiet links to the policies, for the foot of a page. */
export function LegalLinks() {
  return (
    <p className="legal-links">
      <Link to="/privacy">Privacy Policy</Link>
      <Link to="/terms">Terms of Use</Link>
    </p>
  );
}
