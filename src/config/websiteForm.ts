/**
 * Field names the website form may send, per normalized field. Matching
 * ignores case and treats "-", "_" and spaces alike, so "your-name",
 * "Your Name" and "your_name" all match. Covers Contact Form 7, WPForms and
 * Gravity Forms defaults; add the real form's field names once we can see it.
 */
export const websiteFieldAliases = {
  name: ["name", "full name", "your name", "customer name"],
  firstName: ["first name", "fname", "name first"],
  lastName: ["last name", "lname", "name last"],
  phone: ["phone", "phone number", "your phone", "tel", "your tel", "telephone", "mobile", "cell"],
  email: ["email", "your email", "email address", "e mail"],
  address: ["address", "street address", "property address", "your address", "address line 1"],
  city: ["city", "your city"],
  zip: ["zip", "zip code", "zipcode", "postal code", "your zip", "address zip"],
  service: ["service", "services", "service type", "service needed", "your service", "subject", "your subject"],
  message: ["message", "your message", "comments", "comment", "details", "description", "project details"],
  smsConsent: ["sms consent", "text consent", "consent sms", "sms opt in", "acceptance sms", "sms"],
  entryId: ["entry id", "submission id", "form entry id", "lead id"],
  submittedAt: ["submitted at", "date created", "submission date", "date"],
} as const;

export type WebsiteField = keyof typeof websiteFieldAliases;
