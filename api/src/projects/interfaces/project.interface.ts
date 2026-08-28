export enum ProjectStatusEnum {
  Pending = 'Pending',
  Approved = 'Approved',
  Rejected = 'Rejected',
  Inactive = 'Inactive',
}

export interface ProjectResponse {
  id: number;
  name: string;
  status: ProjectStatusEnum;
  methodology: string;
  country: string;
  metadataIpfsHash: string;
  ownerAddress: string;
  totalAreaHa: number;
  carbonSequestrationEstimate: number;
  createdAt: string;
}

export interface ProjectSummaryResponse {
  id: number;
  name: string;
  status: ProjectStatusEnum;
  country: string;
}

export interface DocumentUploadResponse {
  projectId: number;
  documentHashes: string[];
  gatewayUrls: string[];
}
