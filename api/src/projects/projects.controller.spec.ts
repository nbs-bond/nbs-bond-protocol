import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

describe('ProjectsController', () => {
  let controller: ProjectsController;
  let service: jest.Mocked<ProjectsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        {
          provide: ProjectsService,
          useValue: {
            register: jest.fn(),
            findAll: jest.fn(),
            findOne: jest.fn(),
            approve: jest.fn(),
            reject: jest.fn(),
            uploadDocuments: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ProjectsController>(ProjectsController);
    service = module.get(ProjectsService);
  });

  it('should register a project', async () => {
    const dto = { name: 'P1', methodology: 'M1', country: 'C1', location: 'L1', totalAreaHa: 10, carbonSequestrationEstimate: 100 };
    const expected = { id: 1 } as any;
    service.register.mockResolvedValue(expected);

    const result = await controller.register(dto as any);

    expect(service.register).toHaveBeenCalledWith(dto, '');
    expect(result).toBe(expected);
  });

  it('should find all projects', async () => {
    const expected = { data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 1 } };
    service.findAll.mockResolvedValue(expected);

    const result = await controller.findAll({ page: 1, limit: 10 });

    expect(service.findAll).toHaveBeenCalledWith(1, 10);
    expect(result).toBe(expected);
  });

  it('should find one project by ID', async () => {
    const expected = { id: 1 } as any;
    service.findOne.mockResolvedValue(expected);

    const result = await controller.findOne(1);

    expect(service.findOne).toHaveBeenCalledWith(1);
    expect(result).toBe(expected);
  });

  it('should approve a project', async () => {
    const expected = { id: 1, status: 'Approved' } as any;
    service.approve.mockResolvedValue(expected);

    const result = await controller.approve(1);

    expect(service.approve).toHaveBeenCalledWith(1);
    expect(result).toBe(expected);
  });

  it('should reject a project', async () => {
    const expected = { id: 1, status: 'Rejected' } as any;
    service.reject.mockResolvedValue(expected);

    const result = await controller.reject(1);

    expect(service.reject).toHaveBeenCalledWith(1);
    expect(result).toBe(expected);
  });

  it('should upload documents for a project', async () => {
    const files = [{ originalname: 'file1.txt' }];
    const expected = { projectId: 1, documentHashes: ['hash1'], gatewayUrls: ['url1'] };
    service.uploadDocuments.mockResolvedValue(expected);

    const result = await controller.uploadDocuments(1, { files });

    expect(service.uploadDocuments).toHaveBeenCalledWith(1, files);
    expect(result).toBe(expected);
  });
});
