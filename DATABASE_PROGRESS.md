# Database Implementation Progress

## Overview
This document tracks the database models and their implementation status for the Certified Australia portal. Updated with each model addition.

**Current Date:** April 28, 2026  
**Stack:** MongoDB + Mongoose (Node.js)

---

## Models Implemented

### 1. **User** (Base Model)
- **Purpose:** Core authentication and role-based access control
- **Key Fields:** email, password (hashed), firstName, lastName, role, status, MFA settings
- **Roles:** Admin, Agent, Student, InternalRTO, ExternalRTO, Support, CEOReportingManager
- **ISO Compliance:** Password hashing (bcrypt), email verification, MFA tracking
- **Status:** ✅ Complete

### 2. **Student** (Extends User)
- **Purpose:** Student-specific data extending base User model
- **Key Fields:** USI, application IDs, source attribution, consents
- **ISO Compliance:** Terms of service acceptance, e-signature tracking, consent audit trail
- **Status:** ✅ Complete

### 3. **Industry**
- **Purpose:** Catalogue of industries that qualifications belong to
- **Key Fields:** name, description, status (active/inactive)
- **Status:** ✅ Complete

### 4. **Qualification**
- **Purpose:** Definition of qualifications offered, with pricing and document requirements
- **Key Fields:** name, industry ref, CA price, RTO cost, checklist ref, reference letter template ref
- **Notable:** Supports per-qualification document requirements, unit-by-unit upload toggle
- **Status:** ✅ Complete

### 5. **Checklist**
- **Purpose:** Unit-of-competency list for each qualification
- **Key Fields:** qualificationId ref, units array (code, name, description)
- **Status:** ✅ Complete

### 6. **Application** (Controller Model)
- **Purpose:** Central model driving the entire student application lifecycle (19-stage journey)
- **Key Fields:**
  - `applicationId` (unique, APP10000 format)
  - `studentId`, `industryId`, `qualificationId`
  - `status` (19 states from Lead Captured → Delivered)
  - `assignedAgentId`, `assignedRTOId`
  - Financial refs (paymentIds, paymentPlanId)
  - Form refs (intakeFormId, screeningFormId)
  - Document refs, certificateId
  - Lifecycle tracking (notes, followUpCalls, tasks, resubmissionRequests)
  - 21-day KPI timer fields (studentCompletionDate, rtoCompletionDeadline, timerPausedAt)
- **ISO Compliance:** Full audit trail on status changes, notes visibility by role
- **Status:** ✅ Complete

### 7. **IntakeForm**
- **Purpose:** Stores intake data per application
- **Key Fields:**
  - applicationId
  - Personal: firstName, middleName, surname, USI, gender, dateOfBirth
  - Address: streetAddress, suburb, postcode, state
  - Contact: phoneNumber, email, countryOfBirth, englishLevel
  - Additional: citizenship, aboriginal/torres strait, disability
  - Education & Employment: previousQualifications, employmentStatus
  - Employment Details: businessName, position, employerLegalName, employerPhone, employerAddress
  - Credits Transfer: hasCreditToTransfer, creditQualificationName, creditYearCompleted
- **Status:** ✅ Complete

### 8. **ScreeningForm**
- **Purpose:** Entry point form attached to each application where the student selects industry and qualification, then provides work/education background
- **Key Fields:**
  - applicationId, industryId, qualificationId
  - yearsOfExperience, experienceLocation
  - state (location)
  - hasFormalQualifications, formalQualifications array
- **Status:** ✅ Complete

### 9. **Payment**
- **Purpose:** Individual payment transaction tracking with multiple types
- **Payment Types:** upfront, plan (installment), discount, manualMarkPaid, refund, rtoPayable, rtoPayment
- **Key Fields:**
  - applicationId, studentId, amount
  - type, paymentMethod (square, manual, directDebit)
  - status (pending, completed, failed, refunded, reversed)
  - Square integration (transactionId, paymentId)
  - Xero sync (invoiceId, syncStatus, syncedAt)
  - Manual payment tracking (reference, reason)
  - MFA approval fields for elevated actions
  - Audit (authorizedBy, approvedByMFA)
- **ISO Compliance:** Audit trail on every transaction, approval tracking, MFA for high-value payments
- **Status:** ✅ Complete

### 10. **PaymentPlan**
- **Purpose:** Payment plan structure supporting installment scheduling, discounts, and direct debit
- **Key Fields:**
  - applicationId, studentId
  - totalAmount, totalPaidAmount, discountApplied
  - installments array (index, amount, dueDate, status, paidAmount, paymentDate, paymentIds)
  - directDebitEnabled, directDebitAccountDetails
  - Xero invoiceId
- **Payment Logic:** 
  - Partial payment tracking: if 1000 marked paid on plan of 1000+2000+2000, next 1000 paid applies to next installment
  - Paid installments are immutable; only future ones editable
  - Each installment can be partially or fully paid
- **Status:** ✅ Complete

### 11. **Certificate**
- **Purpose:** Certificate issuance and delivery tracking
- **Key Fields:**
  - applicationId, studentId, issuedBy (RTO/Admin ref)
  - certificateLink, googleDriveFileId
  - trackingNumber, trackingLink (Australia Post)
  - status (issued, in_delivery, delivered, failed_delivery)
  - Timestamps: issuedAt, dispatchedAt, deliveredAt
- **Status:** ✅ Complete

### 12. **Document**
- **Purpose:** Per-document tracking in applications (stored in Google Drive)
- **Key Fields:**
  - applicationId, studentId
  - fileName, fileType, googleDriveFileId, googleDriveLink
  - documentType (Identity, Work Experience, Educational Qualifications, Reference Letter, Other)
  - qualificationUnitCode (for unit-by-unit uploads)
  - version (re-upload support with version tracking)
  - previousVersionFileIds (history preservation)
  - status (uploaded, verified, rejected, resubmitted)
  - Audit: uploadedBy, uploadedAt, verifiedBy, verifiedAt
  - rtoAccessExpiresAt (30-day expiry for RTO access)
- **ISO Compliance:** Full version history, upload audit trail, expiring access
- **Status:** ✅ Complete

### 13. **ReferenceLetterTemplate**
- **Purpose:** Per-qualification reference letter template stored as a Google Drive document or PDF
- **Key Fields:** qualificationId, fileName, fileType, googleDriveFileId, googleDriveLink, version, uploadedBy, uploadedAt
- **ISO Compliance:** Drive-backed file reference with version tracking and upload audit trail
- **Status:** ✅ Complete

### 14. **Task**
- **Purpose:** General task management for agents and admins (Kanban board support), optionally linked to an application or student
- **Key Fields:**
  - scopeType, applicationId, studentId
  - title, description, status (todo, in_progress, done)
  - priority (low, medium, high)
  - assignedTo, createdBy
  - dueDate, completedAt
- **Status:** ✅ Complete

---

## Key Design Decisions

### 1. **User Inheritance (Discriminator Pattern)**
- Base `User` model with `discriminatorKey: 'userType'`
- `Student` extends User with role-specific fields
- Supports multiple user types: Admin, Agent, Student, RTO, Support, CEO/Reporting Manager

### 2. **Application as Controller Model**
- Single source of truth for application state
- Drives 19-stage journey from Lead Captured → Delivered
- Embeds references to all related data (forms, payments, documents, notes)

### 3. **Payment Flexibility**
- `Payment` model: individual transactions
- `PaymentPlan` model: installment scheduling with partial payment support
- Supports Square, manual, and direct debit methods
- MFA approval for high-risk actions

### 4. **Document Versioning**
- Version field tracks re-uploads
- previousVersionFileIds preserves history
- RTO access expires 30 days from upload (ISO compliance)

### 5. **ISO Compliance Baseline**
- Audit trails on all models (createdAt, updatedAt, createdBy, authorizedBy)
- MFA approval tracking on sensitive payments
- Document version and access history
- User consent tracking (terms, e-signature)
- Status enums prevent invalid state transitions

### 6. **Google Drive Integration**
- googleDriveFileId and googleDriveLink on Document model
- googleDriveFolderId on Application model (one folder per application)
- Certificate, Document, and ReferenceLetterTemplate models reference Drive files

### 7. **Application-Owned Forms**
- Intake and screening forms belong to each application, not the student record
- The student model keeps only student-level data and application references
- The application model remains the controller for the full student journey

### 7. **21-Day KPI Tracking**
- Application model includes: studentCompletionDate, rtoCompletionDeadline, rtoCompletionDate
- Timer pause support: timerPausedAt, timerPauseReason
- Breach reporting: timerBreachReported boolean

---

## Relationships Summary

```
User
├── Student (extends)
└── (hasMany) Applications
    ├── (references) Industry
    ├── (references) Qualification
    │   ├── (references) Checklist
    │   └── (references) ReferenceLetterTemplate
    ├── (hasMany) Payments
    ├── (hasOne) PaymentPlan
    │   └── (array of) Installments
    ├── (hasOne) IntakeForm
    ├── (hasOne) ScreeningForm
    ├── (hasMany) Documents (Google Drive)
    ├── (hasOne) Certificate (Google Drive)
    └── (optional hasMany) Tasks
```

---

## Next Steps (To Be Completed)

- Email templates model
- Support ticket model
- Notification model
- Xero integration layer
- RTO portal access control model
- Audit log model (optional: detailed audit events)
- Marketing attribution / campaign tracking model
- Call centre queue model

---

## Database Configuration Notes

- **MongoDB Collections:** 14 primary collections (models)
- **Indexes:** Recommended on: userId, applicationId, studentId, status, createdAt
- **Xero Sync Fields:** Every model with financial data includes xeroId and xeroSyncStatus
- **Timestamps:** All models include createdAt and updatedAt (default Date.now)
- **Soft Deletes:** Not yet implemented; status enums used instead (e.g., 'archived', 'removed')

