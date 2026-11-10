import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, FileText, HelpCircle, MessageCircle, Phone, ShieldCheck } from 'lucide-react';
import { PHONE, PHONE_LABEL } from '../api';
import { PageTitle } from '../ui';

/** WhatsApp chat with Nimpat's customer service line (the MTN line on the website). */
export const WHATSAPP_NUMBER = '2348145537327';
export const WHATSAPP_LABEL = '0814 553 7327';
export function whatsappLink(text = 'Hello Nimpat, I need help with Nimpat One.') {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

/** A round WhatsApp button that floats above the tab bar on every screen. */
export function WhatsAppButton({ raised }: { raised: boolean }) {
  return (
    <a className={`wa-float ${raised ? 'raised' : ''}`} href={whatsappLink()} target="_blank" rel="noreferrer" aria-label="Chat with us on WhatsApp">
      <MessageCircle size={26} aria-hidden="true" />
    </a>
  );
}

const FAQ: { q: string; a: string }[] = [
  { q: 'Do I need an account to order?', a: 'No. Add what you need to your basket and give your name, email and phone once at checkout. An account lets you see your orders on any device and collect Royalty points.' },
  { q: 'Where do you deliver?', a: 'We deliver within Abuja. The delivery fee for your address is shown at checkout before you pay. You can also pick up from our store for free.' },
  { q: 'How can I pay?', a: 'Online by card, bank or USSD (Paystack), by bank transfer, or where offered, on delivery or in the store. The choices for your order are shown at checkout.' },
  { q: 'Is VAT included in the prices?', a: 'Water, drinks and wines prices are shown before VAT. 7.5% VAT is added at checkout, on its own line, so you see the full total before you pay.' },
  { q: 'How do I track my order?', a: 'Open Orders at the bottom of the screen and tap your order. You will see each step, from placed to delivered, and we notify you when it moves.' },
  { q: 'Can I change my delivery address?', a: 'Yes, before the order is paid or sent out: open the order and choose Change. After that, please call or WhatsApp us.' },
  { q: 'Why can I not buy some medicines?', a: 'Our pharmacist checks every medicine before it can be sold online. Prescription medicines need a pharmacist review, so you can book a pharmacist from the Pharmacy page instead.' },
  { q: 'Why am I asked my age for some drinks?', a: 'Alcohol is only sold to adults aged 18 and over. You may be asked for ID on delivery.' },
  { q: 'What are Royalty points?', a: 'Members earn points on payments for orders and bookings. Points are added once a payment is confirmed. See Royalty Member for the current rates.' },
];

export function HelpPage() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <>
      <PageTitle title="Help & FAQ" sub="Answers to common questions, and how to reach us." />
      <section className="panel contact-panel">
        <h2>Talk to us</h2>
        <a className="contact-row wa" href={whatsappLink()} target="_blank" rel="noreferrer"><MessageCircle size={20} aria-hidden="true" /><span><b>Chat on WhatsApp</b><small>{WHATSAPP_LABEL}</small></span><ChevronRight size={18} aria-hidden="true" /></a>
        <a className="contact-row" href={`tel:${PHONE}`}><Phone size={20} aria-hidden="true" /><span><b>Call us</b><small>{PHONE_LABEL}</small></span><ChevronRight size={18} aria-hidden="true" /></a>
      </section>
      <section className="panel faq">
        <h2>Questions</h2>
        {FAQ.map((f, i) => (
          <div key={f.q} className={`faq-item ${open === i ? 'open' : ''}`}>
            <button aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
              <span>{f.q}</span><ChevronDown size={18} aria-hidden="true" />
            </button>
            {open === i && <p>{f.a}</p>}
          </div>
        ))}
      </section>
    </>
  );
}

/** Help, contact and policies, shown on the Account screen. */
export function HelpLinks() {
  return (
    <nav className="panel link-list" aria-label="Help and policies">
      <Link to="/help"><HelpCircle size={19} aria-hidden="true" /> Help & FAQ <ChevronRight size={18} aria-hidden="true" /></Link>
      <a href={whatsappLink()} target="_blank" rel="noreferrer"><MessageCircle size={19} aria-hidden="true" /> Chat on WhatsApp <ChevronRight size={18} aria-hidden="true" /></a>
      <a href={`tel:${PHONE}`}><Phone size={19} aria-hidden="true" /> Call {PHONE_LABEL} <ChevronRight size={18} aria-hidden="true" /></a>
      <Link to="/terms"><FileText size={19} aria-hidden="true" /> Terms & Conditions <ChevronRight size={18} aria-hidden="true" /></Link>
      <Link to="/privacy"><ShieldCheck size={19} aria-hidden="true" /> Privacy Policy <ChevronRight size={18} aria-hidden="true" /></Link>
    </nav>
  );
}
