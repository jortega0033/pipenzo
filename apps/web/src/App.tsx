import { Audiences } from './sections/Audiences.js';
import { Footer } from './sections/Footer.js';
import { Hero } from './sections/Hero.js';
import { HowItWorks } from './sections/HowItWorks.js';
import { HumanBoundary } from './sections/HumanBoundary.js';
import { Operations } from './sections/Operations.js';
import { OpenSource } from './sections/OpenSource.js';
import { ReviewBeforeTrust } from './sections/ReviewBeforeTrust.js';
import { SmallPrs } from './sections/SmallPrs.js';
import { StatusSection } from './sections/StatusSection.js';

export function App() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Hero />
      <main id="main">
        <HowItWorks />
        <SmallPrs />
        <ReviewBeforeTrust />
        <HumanBoundary />
        <Operations />
        <Audiences />
        <OpenSource />
        <StatusSection />
      </main>
      <Footer />
    </>
  );
}
