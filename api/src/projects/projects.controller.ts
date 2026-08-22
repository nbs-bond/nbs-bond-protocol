import {
  Controller, Get, Post, Body, Param, Query,
  HttpCode, HttpStatus, ParseIntPipe, UseGuards,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { ProjectResponse } from './interfaces/project.interface';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: CreateProjectDto): Promise<ProjectResponse> {
    return this.projectsService.register(dto, '');
  }

  @Get()
  async findAll(@Query() query: PaginationDto) {
    return this.projectsService.findAll(query.page, query.limit);
  }

  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProjectResponse> {
    return this.projectsService.findOne(id);
  }

  @Post(':id/approve')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProjectResponse> {
    return this.projectsService.approve(id);
  }

  @Post(':id/reject')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ProjectResponse> {
    return this.projectsService.reject(id);
  }

  @Post(':id/documents')
  @HttpCode(HttpStatus.OK)
  async uploadDocuments(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { files: any[] },
  ): Promise<any> {
    return this.projectsService.uploadDocuments(id, body.files || []);
  }
}
