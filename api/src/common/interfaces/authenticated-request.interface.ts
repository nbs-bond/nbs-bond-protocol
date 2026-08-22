import { Request } from "express";

export enum KycStatus {
  NONE = "none",
  PENDING = "pending",
  VERIFIED = "verified",
  ACCREDITED = "accredited",
}

export interface AuthenticatedUser {
  walletAddress: string;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  requestId: string;
}
