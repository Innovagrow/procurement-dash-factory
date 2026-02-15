// KHMDHS/KIMDIS OpenData API Connector for Greek Public Procurement
// API Documentation: https://cerpp.eprocurement.gov.gr/khmdhs-opendata/help
// Swagger: https://cerpp.eprocurement.gov.gr/khmdhs-opendata/swagger-ui/index.html

import axios from 'axios';

const KIMDIS_API_URL = process.env.KIMDIS_API_URL || 'https://cerpp.eprocurement.gov.gr/khmdhs-opendata';

export interface KIMDISTender {
  id: string;
  versionId: number;
  title: string;
  description?: string;
  cpvCodes?: string[];
  contractingAuthorityName?: string;
  contractingAuthorityAddress?: string;
  estimatedValue?: number;
  currency?: string;
  publicationDate?: string;
  submissionDeadline?: string;
  procedureType?: string;
  status?: string;
  detailsUrl?: string;
}

export interface KIMDISSearchParams {
  searchTerm?: string;
  cpvCodes?: string[];
  region?: string;
  minValue?: number;
  maxValue?: number;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export class KIMDISConnector {
  private baseUrl: string;

  constructor() {
    this.baseUrl = KIMDIS_API_URL;
  }

  /**
   * Search for tenders in KIMDIS
   */
  async searchTenders(params: KIMDISSearchParams): Promise<KIMDISTender[]> {
    try {
      // Note: The actual KIMDIS API endpoint structure may vary
      // This is a simplified implementation based on common patterns
      const response = await axios.get(`${this.baseUrl}/api/tenders/search`, {
        params: {
          q: params.searchTerm,
          cpv: params.cpvCodes?.join(','),
          region: params.region,
          minValue: params.minValue,
          maxValue: params.maxValue,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
          page: params.page || 0,
          size: params.pageSize || 20,
        },
        timeout: 30000, // 30 seconds
      });

      return this.normalizeTenders(response.data);
    } catch (error: any) {
      console.error('KIMDIS API error:', error.message);
      
      // Return empty array on error (for MVP - implement proper error handling later)
      return [];
    }
  }

  /**
   * Get tender details by ID
   */
  async getTenderById(id: string): Promise<KIMDISTender | null> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tenders/${id}`, {
        timeout: 30000,
      });

      return this.normalizeTender(response.data);
    } catch (error: any) {
      console.error(`KIMDIS API error fetching tender ${id}:`, error.message);
      return null;
    }
  }

  /**
   * Get active tenders (for daily ingestion)
   */
  async getActiveTenders(days: number = 7): Promise<KIMDISTender[]> {
    const dateTo = new Date();
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    return this.searchTenders({
      dateFrom: dateFrom.toISOString().split('T')[0],
      dateTo: dateTo.toISOString().split('T')[0],
      pageSize: 100,
    });
  }

  /**
   * Normalize tender data from KIMDIS API format to our internal format
   */
  private normalizeTender(data: any): KIMDISTender {
    return {
      id: data.id || data.noticeId,
      versionId: data.versionId || 1,
      title: data.title || data.noticeName || 'Untitled',
      description: data.description || data.shortDescription,
      cpvCodes: this.extractCPVCodes(data),
      contractingAuthorityName: data.contractingAuthorityName || data.buyer?.name,
      contractingAuthorityAddress: data.contractingAuthorityAddress || data.buyer?.address,
      estimatedValue: data.estimatedValue || data.value,
      currency: data.currency || 'EUR',
      publicationDate: data.publicationDate || data.publishedDate,
      submissionDeadline: data.submissionDeadline || data.deadline,
      procedureType: data.procedureType,
      status: data.status || 'ACTIVE',
      detailsUrl: data.detailsUrl || `https://nepps-search.eprocurement.gov.gr/`,
    };
  }

  private normalizeTenders(data: any): KIMDISTender[] {
    const items = data.items || data.content || data.results || data;
    
    if (!Array.isArray(items)) {
      return [];
    }

    return items.map((item) => this.normalizeTender(item));
  }

  private extractCPVCodes(data: any): string[] {
    const codes: string[] = [];

    if (data.cpvCodes && Array.isArray(data.cpvCodes)) {
      codes.push(...data.cpvCodes);
    }

    if (data.mainCpvCode) {
      codes.push(data.mainCpvCode);
    }

    if (data.additionalCpvCodes && Array.isArray(data.additionalCpvCodes)) {
      codes.push(...data.additionalCpvCodes);
    }

    return [...new Set(codes)]; // Remove duplicates
  }

  /**
   * Get tender documents/attachments
   */
  async getTenderDocuments(tenderId: string): Promise<any[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tenders/${tenderId}/documents`, {
        timeout: 30000,
      });

      return response.data.documents || response.data || [];
    } catch (error: any) {
      console.error(`KIMDIS API error fetching documents for ${tenderId}:`, error.message);
      return [];
    }
  }
}

// Export singleton instance
export const kimdisConnector = new KIMDISConnector();
