import { Mail } from 'lucide-react';
import './via-email.css';

/** Marks something written by replying to an Event Center email: a post, a decision. */
export function ViaEmail({ tip = 'Written as a reply to an Event Center email' }: { tip?: string }) {
  return <span className="pill pill-blue via-email" data-tip={tip}><Mail size={11} aria-hidden />via email</span>;
}
